<?php

declare(strict_types=1);

namespace Waypoint\Runner\Swap;

use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\CloningVisitor;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;
use PhpParser\PrettyPrinter\Standard;

/**
 * Rewrites swap sites in source via the AST (sturdier than string matching).
 * A swap site is an *expression hole*: the replacement is arbitrary code in the
 * target language, not a typed value.
 *
 * Two modes:
 *  - "replace":  $user = User::find(1);   ->   $user = <expression>;
 *  - "indirect": $user = User::find(1);   ->   $user = $__waypointSwaps['key'] ?? (User::find(1));
 *
 * Indirection keeps the rewritten source static while the UI just writes the
 * swap map at runtime — it composes with a form more directly than baking a
 * literal in. Printing is format-preserving so untouched code is byte-identical.
 */
final class Swapper
{
    public const SWAP_MAP_VAR = '__waypointSwaps';

    private \PhpParser\Parser $parser;

    public function __construct()
    {
        $this->parser = (new ParserFactory())->createForHostVersion();
    }

    /**
     * @param array<int,array{line:int,mode?:string,key?:string,expression?:string}> $swaps
     * @return array{source:string,applied:int,errors:array<int,string>}
     */
    public function apply(string $source, array $swaps): array
    {
        $oldStmts = $this->parser->parse($source) ?? [];
        $oldTokens = $this->parser->getTokens();

        // Clone so the format-preserving printer can diff old vs new.
        $newStmts = (new NodeTraverser(new CloningVisitor()))->traverse($oldStmts);

        $errors = [];
        $byLine = [];
        foreach ($swaps as $swap) {
            $byLine[$swap['line']][] = $swap;
        }

        $visitor = new class($byLine, $errors) extends NodeVisitorAbstract {
            public int $applied = 0;

            public function __construct(private array $byLine, public array &$errors)
            {
            }

            public function enterNode(Node $node)
            {
                // We rewrite the RHS of an assignment whose statement starts on
                // a targeted line — the common swap shape ($x = <call>;).
                if (!$node instanceof Expr\Assign) {
                    return null;
                }
                $line = $node->getStartLine();
                if (!isset($this->byLine[$line])) {
                    return null;
                }
                foreach ($this->byLine[$line] as $swap) {
                    $mode = $swap['mode'] ?? 'indirect';
                    try {
                        $node->expr = $this->buildReplacement($mode, $swap, $node->expr);
                        $this->applied++;
                    } catch (\Throwable $e) {
                        $this->errors[] = "line {$line}: {$e->getMessage()}";
                    }
                }
                return null;
            }

            private function buildReplacement(string $mode, array $swap, Expr $original): Expr
            {
                if ($mode === 'replace') {
                    return $this->parseExpr($swap['expression'] ?? 'null');
                }
                // indirect: $__waypointSwaps['key'] ?? (<original>)
                $key = $swap['key'] ?? ('swap_' . $swap['line']);
                $mapAccess = new Expr\ArrayDimFetch(
                    new Expr\Variable(Swapper::SWAP_MAP_VAR),
                    new Node\Scalar\String_($key)
                );
                return new Expr\BinaryOp\Coalesce($mapAccess, $original);
            }

            private function parseExpr(string $code): Expr
            {
                $parser = (new ParserFactory())->createForHostVersion();
                $stmts = $parser->parse('<?php ' . rtrim($code, " \t\n;") . ';');
                if (!$stmts || !($stmts[0] instanceof Node\Stmt\Expression)) {
                    throw new \RuntimeException('replacement is not a valid expression');
                }
                return $stmts[0]->expr;
            }
        };

        (new NodeTraverser($visitor))->traverse($newStmts);

        $printed = (new Standard())->printFormatPreserving($newStmts, $oldStmts, $oldTokens);

        return [
            'source' => $printed,
            'applied' => $visitor->applied,
            'errors' => $visitor->errors,
        ];
    }
}
