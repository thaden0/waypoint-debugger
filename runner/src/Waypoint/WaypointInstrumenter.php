<?php

declare(strict_types=1);

namespace Waypoint\Runner\Waypoint;

use PhpParser\Node;
use PhpParser\Node\Stmt;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\CloningVisitor;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;
use PhpParser\PrettyPrinter\Standard;

/**
 * Injects capture hooks at the entry of selected public methods. A waypoint
 * anchors on a public method: on every entry we record { receiver, args }, which
 * is the exact state the reconstruct+invoke primitive needs to re-enter the
 * method later (`$receiver->method(...$args)`), with no mid-function resume.
 *
 * The injected call is:
 *   \Waypoint\Runner\Capture\Recorder::capture('<id>', $this, func_get_args());
 *
 * This rides the same AST pass as swaps and structure extraction — one parse,
 * three payloads.
 */
final class WaypointInstrumenter
{
    private \PhpParser\Parser $parser;

    public function __construct()
    {
        $this->parser = (new ParserFactory())->createForHostVersion();
    }

    /**
     * @param array<int,array{line:int,id?:string}> $waypoints  keyed by the method-declaration line
     * @return array{source:string,instrumented:array<int,array{id:string,line:int,method:string}>,skipped:array<int,array{line:int,reason:string}>}
     */
    public function instrument(string $source, array $waypoints): array
    {
        $oldStmts = $this->parser->parse($source) ?? [];
        $oldTokens = $this->parser->getTokens();
        $newStmts = (new NodeTraverser(new CloningVisitor()))->traverse($oldStmts);

        $byLine = [];
        foreach ($waypoints as $wp) {
            $byLine[$wp['line']] = $wp;
        }

        $visitor = new class($byLine) extends NodeVisitorAbstract {
            public array $instrumented = [];
            public array $skipped = [];
            private array $classStack = [];

            public function __construct(private array $byLine)
            {
            }

            public function enterNode(Node $node)
            {
                if ($node instanceof Stmt\ClassLike) {
                    $this->classStack[] = $node->name?->toString() ?? '(anon)';
                }
                return null;
            }

            public function leaveNode(Node $node)
            {
                if ($node instanceof Stmt\ClassLike) {
                    array_pop($this->classStack);
                    return null;
                }
                if (!$node instanceof Stmt\ClassMethod) {
                    return null;
                }
                $line = $node->getStartLine();
                if (!isset($this->byLine[$line])) {
                    return null;
                }

                $class = end($this->classStack) ?: '(global)';
                $methodName = $node->name->toString();
                $id = $this->byLine[$line]['id'] ?? ($class . '::' . $methodName);

                if (!$node->isPublic() || $node->isStatic() || $node->isAbstract() || $node->stmts === null) {
                    $this->skipped[] = ['line' => $line, 'reason' => 'not an eligible public instance method'];
                    return null;
                }

                $hook = new Stmt\Expression(new Node\Expr\StaticCall(
                    new Node\Name\FullyQualified('Waypoint\\Runner\\Capture\\Recorder'),
                    'capture',
                    [
                        new Node\Arg(new Node\Scalar\String_($id)),
                        new Node\Arg(new Node\Expr\Variable('this')),
                        new Node\Arg(new Node\Expr\FuncCall(new Node\Name('func_get_args'))),
                    ]
                ));
                array_unshift($node->stmts, $hook);

                $this->instrumented[] = ['id' => $id, 'line' => $line, 'method' => $class . '::' . $methodName];
                return null;
            }
        };

        (new NodeTraverser($visitor))->traverse($newStmts);

        $printed = (new Standard())->printFormatPreserving($newStmts, $oldStmts, $oldTokens);

        return [
            'source' => $printed,
            'instrumented' => $visitor->instrumented,
            'skipped' => $visitor->skipped,
        ];
    }
}
