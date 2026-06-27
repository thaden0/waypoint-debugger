<?php

declare(strict_types=1);

namespace Waypoint\Runner\Run;

use PhpParser\Node;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;
use PhpParser\PrettyPrinter\Standard;
use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Host\HostInterface;
use Waypoint\Runner\Swap\Swapper;
use Waypoint\Runner\Waypoint\WaypointInstrumenter;

/**
 * Runs a slice: applies swaps, injects waypoint capture hooks, loads the
 * resulting source into the resident process, and drives the entry method so the
 * hooks populate the ledger. This is the recording side (capability "a") and the
 * authored-state side (capability "b") share the same invoke path downstream.
 *
 * Loading instrumented code without clashing with already-loaded classes is done
 * by re-namespacing the unit under a unique prefix, then evaluating it. (For a
 * full Laravel app the production path is an include-time stream rewrite / Octane
 * integration; the re-namespace loader is the in-process mechanism that makes the
 * capture loop real and testable today.)
 */
final class SliceRunner
{
    private \PhpParser\Parser $parser;
    private static int $runSeq = 0;

    public function __construct(private HostInterface $host)
    {
        $this->parser = (new ParserFactory())->createForHostVersion();
    }

    /**
     * @param array{path?:string,source:string,class:string,method:string,args?:array<int,mixed>,waypoints?:array<int,array{line:int,id?:string}>,swaps?:array<int,array{line:int,mode?:string,key?:string,expression?:string}>} $req
     * @return array{ok:bool,result?:mixed,runtimeClass?:string,ledgerCount?:int,error?:string}
     */
    public function run(array $req): array
    {
        $source = $req['source'];
        $swaps = $req['swaps'] ?? [];
        $waypoints = $req['waypoints'] ?? [];

        // Swaps applied in replace mode bake the mock expression in (no scope
        // injection needed); indirect-mode swaps are a static-preview affordance.
        if ($swaps !== []) {
            $source = (new Swapper())->apply($source, $swaps)['source'];
        }
        if ($waypoints !== []) {
            $source = (new WaypointInstrumenter())->instrument($source, $waypoints)['source'];
        }

        $prefix = 'WpRun_' . (self::$runSeq++);
        try {
            [$runtimeFqn, $wrapped] = $this->renamespace($source, $req['class'], $prefix);
            // eval() runs in PHP mode already: no <?php tag, and a strict_types
            // declare can't be "first statement" inside eval, so both are stripped.
            $code = preg_replace('/^<\?php\s*/', '', $wrapped);
            eval($code);
        } catch (\Throwable $e) {
            return ['ok' => false, 'error' => 'load failed: ' . $e->getMessage()];
        }

        if (!class_exists($runtimeFqn)) {
            return ['ok' => false, 'error' => "class {$req['class']} not found after load"];
        }

        try {
            $receiver = (new \ReflectionClass($runtimeFqn))->newInstanceArgs($req['receiverArgs'] ?? []);
        } catch (\Throwable $e) {
            return ['ok' => false, 'error' => 'cannot construct receiver: ' . $e->getMessage()];
        }

        $method = $req['method'];
        if (!method_exists($receiver, $method)) {
            return ['ok' => false, 'error' => "method {$method} not found"];
        }

        [$begin, $commit, $rollback] = $this->host->transactionHooks();
        $begin();
        try {
            $result = $receiver->$method(...($req['args'] ?? []));
            // A real run records but does not keep writes by default.
            $rollback();
            return [
                'ok' => true,
                'result' => $this->summarize($result),
                'runtimeClass' => $runtimeFqn,
                'ledgerCount' => count(Recorder::ledger()),
            ];
        } catch (\Throwable $e) {
            $rollback();
            return ['ok' => false, 'error' => $e->getMessage(), 'runtimeClass' => $runtimeFqn];
        }
    }

    /**
     * Rewrite the unit's namespace to a unique prefix so the instrumented class
     * doesn't redeclare an already-loaded one. Returns the runtime FQN of the
     * target class and the printed source.
     *
     * @return array{0:string,1:string}
     */
    private function renamespace(string $source, string $class, string $prefix): array
    {
        $oldStmts = $this->parser->parse($source) ?? [];
        $oldTokens = $this->parser->getTokens();
        $newStmts = (new NodeTraverser(new \PhpParser\NodeVisitor\CloningVisitor()))->traverse($oldStmts);

        $origNs = null;
        $visitor = new class($prefix) extends NodeVisitorAbstract {
            public ?string $origNs = null;

            public function __construct(private string $prefix)
            {
            }

            public function enterNode(Node $node)
            {
                if ($node instanceof Node\Stmt\Namespace_) {
                    $this->origNs = $node->name?->toString();
                    $node->name = new Node\Name($this->prefix . ($this->origNs !== null ? '\\' . $this->origNs : ''));
                }
                // strict_types can't be re-declared inside eval()'d code.
                if ($node instanceof Node\Stmt\Declare_) {
                    return NodeTraverser::REMOVE_NODE;
                }
                return null;
            }
        };
        (new NodeTraverser($visitor))->traverse($newStmts);
        $origNs = $visitor->origNs;

        // No namespace in the source: wrap the whole unit in the prefix namespace.
        if ($origNs === null) {
            $shortClass = $class;
            $runtimeFqn = $prefix . '\\' . ltrim($shortClass, '\\');
            $printed = (new Standard())->prettyPrintFile($newStmts);
            // prettyPrint without an enclosing namespace keeps globals; prepend one.
            $printed = "<?php\nnamespace {$prefix};\n" . preg_replace('/^<\?php\s*/', '', $printed);
            return [$runtimeFqn, $printed];
        }

        $short = $this->shortName($class, $origNs);
        $runtimeFqn = $prefix . '\\' . $origNs . '\\' . $short;
        $printed = (new Standard())->printFormatPreserving($newStmts, $oldStmts, $oldTokens);
        return [$runtimeFqn, $printed];
    }

    private function shortName(string $class, string $ns): string
    {
        $class = ltrim($class, '\\');
        if (str_contains($class, '\\')) {
            return substr($class, strrpos($class, '\\') + 1);
        }
        return $class;
    }

    private function summarize(mixed $result): mixed
    {
        if ($result === null || is_scalar($result)) {
            return $result;
        }
        if (is_array($result)) {
            return $result; // small structured results are useful verbatim
        }
        return ['__type' => get_debug_type($result)];
    }
}
