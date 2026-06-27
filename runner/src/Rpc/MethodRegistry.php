<?php

declare(strict_types=1);

namespace Waypoint\Runner\Rpc;

use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Host\HostInterface;
use Waypoint\Runner\Reconstruct\Invoker;
use Waypoint\Runner\Run\SliceRunner;
use Waypoint\Runner\Structure\StructureExtractor;
use Waypoint\Runner\Swap\ProblemScanner;
use Waypoint\Runner\Swap\Swapper;
use Waypoint\Runner\Waypoint\WaypointInstrumenter;

/**
 * Maps JSON-RPC method names to the runner's capabilities. This is the concrete
 * realization of the per-language adapter contract for PHP — parse, scan,
 * instrument, swap, ledger, and (when a host is attached) live run + invoke.
 * A JS/TS adapter would expose the same method names over the same wire.
 */
final class MethodRegistry
{
    private StructureExtractor $structure;
    private ProblemScanner $scanner;
    private Swapper $swapper;
    private WaypointInstrumenter $waypoints;
    private string $projectRoot;
    private ?HostInterface $host;

    public function __construct(string $projectRoot, ?HostInterface $host = null)
    {
        $this->projectRoot = rtrim($projectRoot, '/');
        $this->host = $host;
        $this->structure = new StructureExtractor();
        $this->scanner = new ProblemScanner();
        $this->swapper = new Swapper();
        $this->waypoints = new WaypointInstrumenter();
    }

    /** @return array<string,callable> */
    public function methods(): array
    {
        $methods = [
            'runner.info' => fn () => [
                'language' => 'php',
                'phpVersion' => PHP_VERSION,
                'projectRoot' => $this->projectRoot,
                'capabilities' => array_merge(
                    ['structure', 'scan', 'swap', 'waypoint', 'ledger'],
                    $this->host !== null ? ['host', 'run', 'invoke'] : []
                ),
                'host' => $this->host?->describe(),
            ],

            'fs.list' => fn (array $p) => $this->fsList($p['glob'] ?? '**/*.php'),
            'fs.read' => fn (array $p) => ['path' => $p['path'], 'source' => $this->readProjectFile($p['path'])],

            'structure.file' => fn (array $p) => $this->structure->extractFile(
                $p['path'],
                $p['source'] ?? $this->readProjectFile($p['path'])
            ),
            'structure.tree' => fn (array $p) => $this->structure->extractTree(
                $this->resolve($p['root'] ?? '.')
            ),

            'swap.scan' => fn (array $p) => [
                'problems' => $this->scanner->scan($p['source'] ?? $this->readProjectFile($p['path'])),
            ],
            'swap.apply' => fn (array $p) => $this->swapper->apply(
                $p['source'] ?? $this->readProjectFile($p['path']),
                $p['swaps'] ?? []
            ),

            'waypoint.instrument' => fn (array $p) => $this->waypoints->instrument(
                $p['source'] ?? $this->readProjectFile($p['path']),
                $p['waypoints'] ?? []
            ),

            'ledger.get' => fn () => ['entries' => Recorder::ledger()],
            'ledger.reset' => function () {
                Recorder::reset();
                return ['ok' => true];
            },
        ];

        if ($this->host !== null) {
            $methods += $this->hostMethods($this->host);
        }

        return $methods;
    }

    /**
     * Live-run methods, available only when a host is attached (the resident
     * bin/host.php process). The HTTP server runs host-less for static analysis.
     *
     * @return array<string,callable>
     */
    private function hostMethods(HostInterface $host): array
    {
        return [
            'host.describe' => fn () => $host->describe(),
            'host.boot' => function () use ($host) {
                $host->boot();
                return $host->describe();
            },
            'host.entry' => fn (array $p) => $host->renderEntry(
                $p['method'] ?? 'GET',
                $p['uri'] ?? '/',
                $p['params'] ?? []
            ),

            // Drive a slice: instrument (waypoints + swaps), load, run the entry,
            // populate the ledger. Captures stream over the Notifier as they happen.
            'run.slice' => function (array $p) use ($host) {
                Recorder::reset();
                $host->boot();
                $runner = new SliceRunner($host);
                $source = $p['source'] ?? $this->readProjectFile($p['path']);
                $result = $runner->run([
                    'source' => $source,
                    'class' => $p['class'],
                    'method' => $p['method'],
                    'args' => $p['args'] ?? [],
                    'receiverArgs' => $p['receiverArgs'] ?? [],
                    'waypoints' => $p['waypoints'] ?? [],
                    'swaps' => $p['swaps'] ?? [],
                ]);
                $result['ledger'] = Recorder::ledger();
                return $result;
            },

            // Reconstruct + invoke from a captured (or authored) ledger entry.
            'run.invoke' => function (array $p) use ($host) {
                $entry = isset($p['entry']) ? $p['entry'] : Recorder::entry((int) ($p['seq'] ?? -1));
                if ($entry === null) {
                    throw new RpcException(-32010, 'no ledger entry for seq ' . ($p['seq'] ?? '?'));
                }
                [$begin, $commit, $rollback] = $host->transactionHooks();
                $invoker = new Invoker($begin, $commit, $rollback);
                return $invoker->invoke($entry, $p['method'], $p['mode'] ?? 'peek');
            },
        ];
    }

    private function fsList(string $glob): array
    {
        $paths = [];
        $base = $this->projectRoot;
        $iter = new \RecursiveIteratorIterator(
            new \RecursiveCallbackFilterIterator(
                new \RecursiveDirectoryIterator($base, \FilesystemIterator::SKIP_DOTS),
                static function (\SplFileInfo $f): bool {
                    if ($f->isDir()) {
                        return !in_array($f->getFilename(), ['vendor', 'node_modules', '.git'], true);
                    }
                    return str_ends_with($f->getFilename(), '.php');
                }
            )
        );
        foreach ($iter as $f) {
            if ($f->isFile()) {
                $paths[] = ltrim(str_replace($base, '', $f->getPathname()), '/');
            }
        }
        sort($paths);
        return ['root' => $base, 'paths' => $paths];
    }

    private function readProjectFile(string $path): string
    {
        $full = $this->resolve($path);
        $contents = @file_get_contents($full);
        if ($contents === false) {
            throw new RpcException(-32001, "cannot read file: {$path}");
        }
        return $contents;
    }

    /** Resolve a project-relative path, refusing escapes outside the root. */
    private function resolve(string $path): string
    {
        $full = str_starts_with($path, '/') ? $path : $this->projectRoot . '/' . ltrim($path, '/');
        $real = realpath($full) ?: $full;
        if (!str_starts_with($real, $this->projectRoot)) {
            throw new RpcException(-32002, "path escapes project root: {$path}");
        }
        return $real;
    }
}
