<?php

declare(strict_types=1);

namespace Waypoint\Runner\Instrument;

use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Stmt;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\CloningVisitor;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;
use PhpParser\PrettyPrinter\Standard;
use Waypoint\Runner\Debug\BreakpointInstrumenter;
use Waypoint\Runner\Swap\Swapper;

/**
 * Single-pass instrumentation. Applies swaps, variable overrides, waypoint
 * capture hooks, and breakpoint hooks in ONE traversal of the ORIGINAL AST.
 *
 * Run as separate re-parsing passes, each insertion shifted the line numbers the
 * next pass relied on — so a waypoint (hook at method entry) would push a
 * breakpoint a line off. Keyed to the original line numbers in one pass, every
 * operation lands where the user placed it, and the printer reconciles all the
 * insertions/replacements together.
 */
final class Instrumenter
{
    private \PhpParser\Parser $parser;

    public function __construct()
    {
        $this->parser = (new ParserFactory())->createForHostVersion();
    }

    /**
     * @param array{
     *   swaps?:array<int,array{line:int,mode?:string,key?:string,expression?:string}>,
     *   overrides?:array<int,array{line:int,var:string,expression:string}>,
     *   waypoints?:array<int,array{line:int,id?:string}>,
     *   breakpoints?:array<int,array{line:int,id?:string}>
     * } $ops
     */
    public function apply(string $source, array $ops): string
    {
        $old = $this->parser->parse($source) ?? [];
        $tokens = $this->parser->getTokens();
        $new = (new NodeTraverser(new CloningVisitor()))->traverse($old);

        $visitor = new class(
            $this->singleByLine($ops['swaps'] ?? []),
            $this->multiByLine($ops['overrides'] ?? []),
            $this->singleByLine($ops['waypoints'] ?? []),
            $this->singleByLine($ops['breakpoints'] ?? []),
            $this->parser,
        ) extends NodeVisitorAbstract {
            /** @var array<int,string> */
            private array $classStack = [];
            private array $placedBp = [];
            private array $placedOv = [];

            public function __construct(
                private array $swaps,
                private array $overrides,
                private array $waypoints,
                private array $breakpoints,
                private \PhpParser\Parser $parser,
            ) {
            }

            public function enterNode(Node $node)
            {
                if ($node instanceof Stmt\ClassLike) {
                    $this->classStack[] = $node->name?->toString() ?? '(anon)';
                }
                // swap: replace the RHS of an assignment on a swap line (in place,
                // no line shift).
                if ($node instanceof Expr\Assign && isset($this->swaps[$node->getStartLine()])) {
                    $node->expr = $this->swapExpr($this->swaps[$node->getStartLine()], $node->expr);
                }
                return null;
            }

            public function leaveNode(Node $node)
            {
                if ($node instanceof Stmt\ClassLike) {
                    array_pop($this->classStack);
                    return null;
                }

                // waypoint hook at method entry — unshift AFTER the body is
                // traversed so any breakpoint/override inside is already placed.
                if ($node instanceof Stmt\ClassMethod) {
                    $wp = $this->waypoints[$node->getStartLine()] ?? null;
                    if ($wp !== null && $node->stmts !== null && $node->isPublic() && !$node->isStatic() && !$node->isAbstract()) {
                        $class = end($this->classStack) ?: '(global)';
                        $id = $wp['id'] ?? ($class . '::' . $node->name->toString());
                        array_unshift($node->stmts, $this->waypointHook($id));
                    }
                    return null;
                }

                if (!$node instanceof Stmt) {
                    return null;
                }

                $line = $node->getStartLine();
                $prepend = [];

                if (isset($this->overrides[$line]) && !isset($this->placedOv[$line])) {
                    $this->placedOv[$line] = true;
                    foreach ($this->overrides[$line] as $ov) {
                        $prepend[] = $this->overrideAssign($ov['var'], $ov['expression']);
                    }
                }

                if (isset($this->breakpoints[$line]) && !isset($this->placedBp[$line]) && $this->breakable($node)) {
                    $this->placedBp[$line] = true;
                    $bp = $this->breakpoints[$line];
                    $prepend[] = $this->breakpointHook($bp['id'] ?? ('bp:' . $line));
                }

                return $prepend !== [] ? [...$prepend, $node] : null;
            }

            private function breakable(Stmt $node): bool
            {
                foreach (BreakpointInstrumenter::skipKinds() as $skip) {
                    if ($node instanceof $skip) {
                        return false;
                    }
                }
                return true;
            }

            private function swapExpr(array $swap, Expr $original): Expr
            {
                if (($swap['mode'] ?? 'indirect') === 'replace') {
                    return $this->parseExpr($swap['expression'] ?? 'null');
                }
                $key = $swap['key'] ?? ('swap_' . $swap['line']);
                return new Expr\BinaryOp\Coalesce(
                    new Expr\ArrayDimFetch(new Expr\Variable(Swapper::SWAP_MAP_VAR), new Node\Scalar\String_($key)),
                    $original
                );
            }

            private function overrideAssign(string $var, string $expression): Stmt\Expression
            {
                $stmts = $this->parser->parse('<?php $' . $var . ' = (' . rtrim($expression, " \t\n;") . ');');
                if (!$stmts || !($stmts[0] instanceof Stmt\Expression)) {
                    throw new \RuntimeException("invalid override expression for \${$var}");
                }
                return $stmts[0];
            }

            private function parseExpr(string $code): Expr
            {
                $stmts = $this->parser->parse('<?php ' . rtrim($code, " \t\n;") . ';');
                if (!$stmts || !($stmts[0] instanceof Stmt\Expression)) {
                    throw new \RuntimeException('invalid replacement expression');
                }
                return $stmts[0]->expr;
            }

            private function waypointHook(string $id): Stmt\Expression
            {
                return new Stmt\Expression(new Expr\StaticCall(
                    new Node\Name\FullyQualified('Waypoint\\Runner\\Capture\\Recorder'),
                    'capture',
                    [
                        new Node\Arg(new Node\Scalar\String_($id)),
                        new Node\Arg(new Expr\Variable('this')),
                        new Node\Arg(new Expr\FuncCall(new Node\Name('func_get_args'))),
                    ]
                ));
            }

            private function breakpointHook(string $id): Stmt\Expression
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

        (new NodeTraverser($visitor))->traverse($new);
        return (new Standard())->printFormatPreserving($new, $old, $tokens);
    }

    /** @return array<int,array<string,mixed>> last op per line wins */
    private function singleByLine(array $ops): array
    {
        $out = [];
        foreach ($ops as $op) {
            $out[$op['line']] = $op;
        }
        return $out;
    }

    /** @return array<int,array<int,array<string,mixed>>> all ops per line */
    private function multiByLine(array $ops): array
    {
        $out = [];
        foreach ($ops as $op) {
            $out[$op['line']][] = $op;
        }
        return $out;
    }
}
