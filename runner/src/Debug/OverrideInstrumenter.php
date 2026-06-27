<?php

declare(strict_types=1);

namespace Waypoint\Runner\Debug;

use PhpParser\Node;
use PhpParser\Node\Stmt;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\CloningVisitor;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;
use PhpParser\PrettyPrinter\Standard;

/**
 * "Change a variable on the fly." Injects an assignment before the statement at a
 * line, so a re-run continues from there with the variable overridden:
 *
 *   $var = (<expression>);
 *
 * This is the breakpoint ↔ swap bridge: edit a value at a paused breakpoint, then
 * re-run with the override applied — snapshot-and-re-run, not live mutation. The
 * expression is arbitrary code (defaulting to a literal of the edited value).
 */
final class OverrideInstrumenter
{
    private \PhpParser\Parser $parser;

    public function __construct()
    {
        $this->parser = (new ParserFactory())->createForHostVersion();
    }

    /**
     * @param array<int,array{line:int,var:string,expression:string}> $overrides
     * @return array{source:string,applied:array<int,array{line:int,var:string}>,errors:array<int,string>}
     */
    public function apply(string $source, array $overrides): array
    {
        $oldStmts = $this->parser->parse($source) ?? [];
        $oldTokens = $this->parser->getTokens();
        $newStmts = (new NodeTraverser(new CloningVisitor()))->traverse($oldStmts);

        $byLine = [];
        foreach ($overrides as $o) {
            $byLine[$o['line']][] = $o;
        }

        $errors = [];
        $assignsByLine = [];
        foreach ($byLine as $line => $list) {
            foreach ($list as $o) {
                try {
                    $assignsByLine[$line][] = $this->buildAssign($o['var'], $o['expression']);
                } catch (\Throwable $e) {
                    $errors[] = "line {$line} \${$o['var']}: {$e->getMessage()}";
                }
            }
        }

        $visitor = new class($assignsByLine) extends NodeVisitorAbstract {
            public array $applied = [];
            private array $placedLines = [];

            public function __construct(private array $assignsByLine)
            {
            }

            public function leaveNode(Node $node)
            {
                if (!$node instanceof Stmt) {
                    return null;
                }
                $line = $node->getStartLine();
                if (!isset($this->assignsByLine[$line]) || isset($this->placedLines[$line])) {
                    return null;
                }
                $this->placedLines[$line] = true;
                $assigns = $this->assignsByLine[$line];
                foreach ($assigns as $a) {
                    $this->applied[] = ['line' => $line, 'var' => $a->expr->var->name];
                }
                return [...$assigns, $node];
            }
        };

        (new NodeTraverser($visitor))->traverse($newStmts);
        $printed = (new Standard())->printFormatPreserving($newStmts, $oldStmts, $oldTokens);

        return ['source' => $printed, 'applied' => $visitor->applied, 'errors' => $errors];
    }

    private function buildAssign(string $var, string $expression): Stmt\Expression
    {
        $stmts = $this->parser->parse('<?php $' . $var . ' = (' . rtrim($expression, " \t\n;") . ');');
        if (!$stmts || !($stmts[0] instanceof Stmt\Expression)) {
            throw new \RuntimeException('invalid override expression');
        }
        return $stmts[0];
    }
}
