<?php

declare(strict_types=1);

namespace Waypoint\Runner\Debug;

use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Stmt;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\CloningVisitor;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;
use PhpParser\PrettyPrinter\Standard;

/**
 * Injects a breakpoint hook BEFORE the first executable statement on each
 * breakpoint line:
 *
 *   \Waypoint\Runner\Debug\Breakpoint::hit('<id>', get_defined_vars(), isset($this) ? $this : null);
 *
 * get_defined_vars() captures every local in scope at that point — the variable
 * view a breakpoint exists to give. Rides the same instrumentation pass as
 * swaps + waypoints.
 */
final class BreakpointInstrumenter
{
    /** Statement kinds we never inject before (declarations / structural). */
    private const SKIP = [
        Stmt\ClassMethod::class, Stmt\Function_::class, Stmt\Class_::class,
        Stmt\Interface_::class, Stmt\Trait_::class, Stmt\Enum_::class,
        Stmt\Namespace_::class, Stmt\Use_::class, Stmt\GroupUse::class,
        Stmt\Declare_::class, Stmt\Property::class, Stmt\ClassConst::class,
        Stmt\Else_::class, Stmt\ElseIf_::class, Stmt\Catch_::class,
        Stmt\Finally_::class, Stmt\Case_::class, Stmt\Nop::class,
    ];

    private \PhpParser\Parser $parser;

    public function __construct()
    {
        $this->parser = (new ParserFactory())->createForHostVersion();
    }

    /**
     * @param array<int,array{line:int,id?:string}> $breakpoints
     * @return array{source:string,placed:array<int,array{id:string,line:int}>,skipped:array<int,array{line:int,reason:string}>}
     */
    public function instrument(string $source, array $breakpoints): array
    {
        $oldStmts = $this->parser->parse($source) ?? [];
        $oldTokens = $this->parser->getTokens();
        $newStmts = (new NodeTraverser(new CloningVisitor()))->traverse($oldStmts);

        $byLine = [];
        foreach ($breakpoints as $bp) {
            $byLine[$bp['line']] = $bp;
        }

        $visitor = new class($byLine) extends NodeVisitorAbstract {
            public array $placed = [];
            private array $placedLines = [];

            public function __construct(private array $byLine)
            {
            }

            public function leaveNode(Node $node)
            {
                if (!$node instanceof Stmt) {
                    return null;
                }
                $line = $node->getStartLine();
                if (!isset($this->byLine[$line]) || isset($this->placedLines[$line])) {
                    return null;
                }
                foreach (BreakpointInstrumenter::skipKinds() as $skip) {
                    if ($node instanceof $skip) {
                        return null;
                    }
                }

                $this->placedLines[$line] = true;
                $id = $this->byLine[$line]['id'] ?? ('bp:' . $line);
                $this->placed[] = ['id' => $id, 'line' => $line];

                return [$this->hook($id), $node];
            }

            private function hook(string $id): Stmt\Expression
            {
                return new Stmt\Expression(new Expr\StaticCall(
                    new Node\Name\FullyQualified('Waypoint\\Runner\\Debug\\Breakpoint'),
                    'hit',
                    [
                        new Node\Arg(new Node\Scalar\String_($id)),
                        new Node\Arg(new Expr\FuncCall(new Node\Name('get_defined_vars'))),
                        new Node\Arg(new Expr\Ternary(
                            new Expr\Isset_([new Expr\Variable('this')]),
                            new Expr\Variable('this'),
                            new Expr\ConstFetch(new Node\Name('null'))
                        )),
                    ]
                ));
            }
        };

        (new NodeTraverser($visitor))->traverse($newStmts);
        $printed = (new Standard())->printFormatPreserving($newStmts, $oldStmts, $oldTokens);

        return ['source' => $printed, 'placed' => $visitor->placed, 'skipped' => []];
    }

    /** @return array<int,class-string> */
    public static function skipKinds(): array
    {
        return self::SKIP;
    }
}
