<?php

declare(strict_types=1);

namespace Waypoint\Runner\Rpc;

use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Docker\Orchestrator;
use Waypoint\Runner\Host\HostInterface;
use Waypoint\Runner\Reconstruct\Invoker;
use Waypoint\Runner\Run\RequestRunner;
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
    private bool $manageHost;

    public function __construct(string $projectRoot, ?HostInterface $host = null)
    {
        $this->projectRoot = rtrim($projectRoot, '/');
        $this->host = $host;
        $this->manageHost = $host !== null; // resident host process re-points its host
        $this->structure = new StructureExtractor();
        $this->scanner = new ProblemScanner();
        $this->swapper = new Swapper();
        $this->waypoints = new WaypointInstrumenter();
    }

    private function requireHost(): HostInterface
    {
        if ($this->host === null) {
            throw new RpcException(-32040, 'no host attached (static-analysis server)');
        }
        return $this->host;
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

            // Switch the project the runner serves — re-points browsing / scan /
            // swap / run.request immediately, and re-creates the host so a fresh
            // single-project session runs against the new root.
            'project.open' => function (array $p) {
                $root = rtrim((string) ($p['root'] ?? ''), '/');
                if ($root === '' || !is_dir($root)) {
                    throw new RpcException(-32041, "not a directory: {$root}");
                }
                $this->projectRoot = $root;
                Recorder::reset();
                if ($this->manageHost) {
                    $this->host = \Waypoint\Runner\Host\HostFactory::for($root, getenv('WP_HOST_DRIVER') ?: null);
                }
                return [
                    'ok' => true,
                    'projectRoot' => $this->projectRoot,
                    'host' => $this->host?->describe(),
                ];
            },

            // Docker mode: lift the runner out of the container set, bring up the
            // dependency services, and resolve how the host reaches them.
            'docker.scan' => function () {
                $orch = Orchestrator::forRoot($this->projectRoot);
                return $orch === null ? ['available' => false] : ['available' => true] + $orch->scan();
            },
            'docker.up' => function (array $p) {
                $orch = Orchestrator::forRoot($this->projectRoot);
                if ($orch === null) {
                    throw new RpcException(-32030, 'no compose file in project root');
                }
                return $orch->up($p['services'] ?? null);
            },
            'docker.down' => function () {
                $orch = Orchestrator::forRoot($this->projectRoot);
                if ($orch === null) {
                    throw new RpcException(-32030, 'no compose file in project root');
                }
                return $orch->down();
            },
        ];

        if ($this->manageHost) {
            $methods += $this->hostMethods();
        }

        return $methods;
    }

    /**
     * Live-run methods, present on the resident host process. They resolve the
     * host at call time (via requireHost) so project.open can re-point it.
     *
     * @return array<string,callable>
     */
    private function hostMethods(): array
    {
        return [
            'host.describe' => fn () => $this->requireHost()->describe(),
            'host.boot' => function () {
                $host = $this->requireHost();
                $host->boot();
                return $host->describe();
            },
            'host.entry' => fn (array $p) => $this->requireHost()->renderEntry(
                $p['method'] ?? 'GET',
                $p['uri'] ?? '/',
                $p['params'] ?? []
            ),

            // Drive a slice: instrument (waypoints + swaps), load, run the entry,
            // populate the ledger. Captures stream over the Notifier as they happen.
            'run.slice' => function (array $p) {
                $host = $this->requireHost();
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
                    'breakpoints' => $p['breakpoints'] ?? [],
                    'breakpointMode' => $p['breakpointMode'] ?? 'halt',
                    'overrides' => $p['overrides'] ?? [],
                ]);
                $result['ledger'] = Recorder::ledger();
                return $result;
            },

            // Whole-request run: spawn a fresh subprocess with include-time
            // instrumentation so capture flows through every targeted class the
            // request touches (controller -> service -> model), not one unit.
            // Captures stream live over the Notifier as the subprocess emits them.
            'run.request' => function (array $p) {
                Recorder::reset();
                $runnerDir = dirname(__DIR__, 2);
                $runner = new RequestRunner($runnerDir);
                $config = [
                    'projectRoot' => $this->projectRoot,
                    'driver' => $p['driver'] ?? $this->host?->describe()['driver'],
                    'psr4' => $p['psr4'] ?? [],
                    'targets' => $p['targets'] ?? [],
                    'entry' => $p['entry'] ?? ['kind' => 'http', 'method' => 'GET', 'uri' => '/'],
                    'breakpointMode' => $p['breakpointMode'] ?? 'trace',
                ];
                return $runner->run($config, static function (string $method, array $params): void {
                    Notifier::notify($method, $params); // ledger.captured + breakpoint.hit
                });
            },

            // Reconstruct + invoke from a captured (or authored) ledger entry.
            // A passed `entry` (e.g. from a whole-request run, whose subprocess has
            // exited) carries base64 blobs and is decoded before reconstruction;
            // otherwise the resident ledger is keyed by seq.
            'run.invoke' => function (array $p) {
                if (isset($p['entry'])) {
                    $entry = $p['entry'];
                    $entry['receiver'] = Recorder::decodeSnapshot($entry['receiver']);
                    $entry['args'] = array_map([Recorder::class, 'decodeSnapshot'], $entry['args']);
                } else {
                    $entry = Recorder::entry((int) ($p['seq'] ?? -1));
                }
                if ($entry === null) {
                    throw new RpcException(-32010, 'no ledger entry for seq ' . ($p['seq'] ?? '?'));
                }
                [$begin, $commit, $rollback] = $this->requireHost()->transactionHooks();
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
