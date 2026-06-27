<?php

declare(strict_types=1);

namespace Waypoint\Runner\Rpc;

use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Docker\Orchestrator;
use Waypoint\Runner\Host\HostInterface;
use Waypoint\Runner\Module\FrameworkModule;
use Waypoint\Runner\Module\ModuleFactory;
use Waypoint\Runner\Module\ModuleRegistry;
use Waypoint\Runner\Module\OrmProvider;
use Waypoint\Runner\Module\ProjectConfig;
use Waypoint\Runner\Workspace\Provisioner;
use Waypoint\Runner\Workspace\Workspace;
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
    private ?FrameworkModule $module;
    private ?HostInterface $host;
    private bool $manageHost;
    private ModuleRegistry $registry;
    private ?\Waypoint\Runner\Debug\DebugManager $debug;

    public function __construct(string $projectRoot, ?FrameworkModule $module = null, ?\Waypoint\Runner\Debug\DebugManager $debug = null)
    {
        $this->projectRoot = rtrim($projectRoot, '/');
        $this->module = $module;
        $this->host = $module?->host();
        $this->debug = $debug;
        $this->registry = ModuleRegistry::default();
        $this->manageHost = $module !== null; // resident host process re-points its module
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

    private function requireModule(): FrameworkModule
    {
        if ($this->module === null) {
            throw new RpcException(-32040, 'no framework module attached (static-analysis server)');
        }
        return $this->module;
    }

    private function requireOrm(): OrmProvider
    {
        $orm = $this->requireModule()->orm();
        if ($orm === null) {
            throw new RpcException(-32060, 'this framework has no ORM provider');
        }
        return $orm;
    }

    /** @return array<string,callable> */
    public function methods(): array
    {
        $methods = [
            'runner.info' => fn () => [
                'language' => 'php',
                'role' => 'backend',
                'phpVersion' => PHP_VERSION,
                'projectRoot' => $this->projectRoot,
                'capabilities' => array_merge(
                    ['structure', 'scan', 'swap', 'waypoint', 'ledger'],
                    $this->module !== null ? ['host', 'run', 'invoke', 'api'] : [],
                    $this->module?->orm() !== null ? ['orm'] : []
                ),
                'host' => $this->host?->describe(),
            ],

            'fs.list' => fn (array $p) => $this->fsList($p['glob'] ?? '**/*.php'),
            'fs.read' => fn (array $p) => ['path' => $p['path'], 'source' => $this->readProjectFile($p['path'])],
            'fs.write' => function (array $p) {
                $full = $this->resolve($p['path']);
                if (@file_put_contents($full, (string) ($p['source'] ?? '')) === false) {
                    throw new RpcException(-32003, "cannot write file: {$p['path']}");
                }
                return ['ok' => true, 'path' => $p['path']];
            },

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
                    $this->module = ModuleFactory::for($root, getenv('WP_HOST_DRIVER') ?: null);
                    $this->host = $this->module->host();
                }
                (new Workspace($this->registry))->add($root); // register / bump recents
                return [
                    'ok' => true,
                    'projectRoot' => $this->projectRoot,
                    'host' => $this->host?->describe(),
                    'module' => $this->module?->id(),
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
            // All compose files in the project (incl. compose.dev/prod.yaml) + the
            // one currently selected — for the settings Docker picker.
            'docker.composeFiles' => fn () => [
                'files' => Orchestrator::composeFiles($this->projectRoot),
                'selected' => ProjectConfig::read($this->projectRoot)['docker']['compose'],
            ],

            // API console persistence: saved requests + environments live in the
            // project app-file (.waypoint/api.json) so a team can share them.
            'api.collection.load' => fn () => ['collection' => $this->loadCollection()],
            'api.collection.save' => function (array $p) {
                $this->saveCollection($p['collection'] ?? []);
                return ['ok' => true];
            },

            // Project settings & module awareness — powers the settings page.
            'modules.available' => fn () => [
                'modules' => $this->registry->availableModules(),
                'languages' => $this->registry->availableLanguages(),
                'providers' => $this->registry->availableProviders(),
                'detected' => $this->registry->detect($this->projectRoot),
                'active' => $this->module?->id(),
            ],
            // Workspace: the user-global known-projects list (~/.waypoint/projects.json)
            // that backs the header project picker, plus opt-in provisioning detection.
            'workspace.projects' => fn () => ['projects' => (new Workspace($this->registry))->projects()],
            'workspace.addProject' => function (array $p) {
                $entry = (new Workspace($this->registry))->add((string) ($p['path'] ?? ''));
                if ($entry === null) {
                    throw new RpcException(-32070, 'not a directory: ' . ($p['path'] ?? ''));
                }
                return ['project' => $entry];
            },
            'workspace.removeProject' => function (array $p) {
                (new Workspace($this->registry))->remove((string) ($p['path'] ?? ''));
                return ['ok' => true];
            },
            'project.status' => fn () => (new Provisioner($this->projectRoot))->status(),
            'project.provision' => function (array $p) {
                $result = (new Provisioner($this->projectRoot))->provision((string) ($p['action'] ?? ''));
                $result['status'] = (new Provisioner($this->projectRoot))->status();
                return $result;
            },

            'project.config.get' => fn () => ['config' => ProjectConfig::read($this->projectRoot)],
            'project.config.save' => function (array $p) {
                $config = $p['config'] ?? [];
                if (!ProjectConfig::write($this->projectRoot, $config)) {
                    throw new RpcException(-32053, 'cannot write .waypoint/config.json');
                }
                // Re-resolve so the new module/providers take effect immediately.
                if ($this->manageHost) {
                    $this->module = ModuleFactory::for($this->projectRoot, getenv('WP_HOST_DRIVER') ?: null);
                    $this->host = $this->module->host();
                }
                return ['ok' => true, 'active' => $this->module?->id(), 'config' => ProjectConfig::read($this->projectRoot)];
            },
        ];

        if ($this->manageHost) {
            $methods += $this->hostMethods();
        }
        if ($this->debug !== null) {
            $methods += $this->debugMethods($this->debug);
        }

        return $methods;
    }

    /**
     * Interactive debug session: pause/resume across a subprocess. start() spawns
     * it; continue/step/stop drive it while the host loop streams its pauses.
     *
     * @return array<string,callable>
     */
    private function debugMethods(\Waypoint\Runner\Debug\DebugManager $debug): array
    {
        return [
            'run.debug.start' => function (array $p) use ($debug) {
                return $debug->start(dirname(__DIR__, 2), [
                    'projectRoot' => $this->projectRoot,
                    'driver' => $p['driver'] ?? $this->host?->describe()['driver'],
                    'psr4' => $p['psr4'] ?? [],
                    'source' => $p['source'] ?? $this->readProjectFile($p['path']),
                    'class' => $p['class'],
                    'method' => $p['method'],
                    'args' => $p['args'] ?? [],
                    'receiverArgs' => $p['receiverArgs'] ?? [],
                    'swaps' => $p['swaps'] ?? [],
                    'breakpoints' => $p['breakpoints'] ?? [],
                ]);
            },
            'run.debug.continue' => function () use ($debug) {
                $debug->send('continue');
                return ['ok' => true];
            },
            'run.debug.step' => function () use ($debug) {
                $debug->send('step');
                return ['ok' => true];
            },
            'run.debug.stop' => function () use ($debug) {
                $debug->stop();
                return ['ok' => true];
            },
        ];
    }

    /**
     * ORM data console — delegates to the framework module's OrmProvider (Eloquent
     * for Laravel; null for frameworks without one). A query is real ORM code,
     * transaction-guarded (peek rolls back, commit persists); models.capture
     * bridges a result into the ledger for the replay what-if loop.
     *
     * @return array<string,callable>
     */
    private function ormMethods(): array
    {
        $orm = fn (): OrmProvider => $this->requireOrm();
        return [
            'models.list' => fn () => ['models' => $orm()->listModels()],
            'models.query' => fn (array $p) => $orm()->query((string) ($p['expr'] ?? ''), (bool) ($p['commit'] ?? false)),
            'models.table' => fn (array $p) => $orm()->table(
                (string) ($p['model'] ?? ''),
                (int) ($p['page'] ?? 1),
                (int) ($p['perPage'] ?? 50),
                $p['filters'] ?? []
            ),
            'models.relationships' => fn (array $p) => ['relationships' => $orm()->relationships((string) ($p['model'] ?? ''))],
            'models.alter' => fn (array $p) => $orm()->alter((string) ($p['model'] ?? ''), $p['props'] ?? []),
            'models.migrate' => fn (array $p) => $orm()->migrate((bool) ($p['run'] ?? false)),
            'models.capture' => fn (array $p) => $orm()->capture((string) ($p['expr'] ?? '')),
        ];
    }

    /**
     * Live-run methods, present on the resident host process. They resolve the
     * host at call time (via requireHost) so project.open can re-point it.
     *
     * @return array<string,callable>
     */
    private function hostMethods(): array
    {
        return $this->ormMethods() + [
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

            // API console: introspect routes from a FRESH boot (a short-lived
            // subprocess), so the listing stays in sync with the route files on
            // disk instead of the resident host's boot-time snapshot. ~one boot of
            // cost, paid on tab-open / explicit refresh.
            'api.routes' => function () {
                $runner = new RequestRunner(dirname(__DIR__, 2));
                $res = $runner->run([
                    'projectRoot' => $this->projectRoot,
                    'driver' => $this->host?->describe()['driver'],
                    'entry' => ['kind' => 'routes'],
                ]);
                return ['routes' => $res['routes'] ?? []];
            },

            // API console: send a request. Two targets — in-process through the
            // instrumented kernel (capture for free, fills the ledger), or a plain
            // external HTTP call run server-side (no CORS, no capture).
            'api.send' => function (array $p) {
                $target = $p['target'] ?? 'inprocess';
                $method = strtoupper($p['method'] ?? 'GET');
                $query = $p['query'] ?? [];
                $headers = $p['headers'] ?? [];
                $body = $p['body'] ?? null;

                if ($target === 'external') {
                    return $this->externalSend($method, (string) ($p['url'] ?? ''), $query, $headers, is_string($body) ? $body : null);
                }

                // In-process: drive a whole instrumented request so placed
                // waypoints/breakpoints fire. Bake the query onto the path; the
                // raw body + headers ride in options.
                $path = '/' . ltrim((string) ($p['uri'] ?? '/'), '/');
                if ($query !== []) {
                    $path .= (str_contains($path, '?') ? '&' : '?') . http_build_query($query);
                }
                $runner = new RequestRunner(dirname(__DIR__, 2));
                $config = [
                    'projectRoot' => $this->projectRoot,
                    'driver' => $p['driver'] ?? $this->host?->describe()['driver'],
                    'psr4' => $p['psr4'] ?? [],
                    'targets' => $p['targets'] ?? [],
                    'breakpointMode' => 'trace',
                    'entry' => [
                        'kind' => 'http',
                        'method' => $method,
                        'uri' => $path,
                        'params' => [],
                        'options' => [
                            'headers' => $headers,
                            'body' => is_string($body) ? $body : null,
                            'contentType' => $p['contentType'] ?? null,
                            'cookies' => $p['cookies'] ?? [],
                        ],
                    ],
                ];
                Recorder::reset();
                $out = $runner->run($config, static function (string $m, array $params): void {
                    Notifier::notify($m, $params); // ledger.captured + breakpoint.hit stream live
                });
                $out['captured'] = true;
                return $out;
            },

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
                return $invoker->invoke($entry, $p['method'], $p['mode'] ?? 'peek', $p['argOverrides'] ?? null);
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

    /** Path to the project app-file holding the API console collection. */
    private function waypointFile(string $name): string
    {
        return $this->projectRoot . '/.waypoint/' . $name;
    }

    /** @return array<string,mixed> */
    private function loadCollection(): array
    {
        $default = ['requests' => [], 'environments' => [], 'activeEnv' => null];
        $file = $this->waypointFile('api.json');
        if (!is_file($file)) {
            return $default;
        }
        $data = json_decode((string) @file_get_contents($file), true);
        return is_array($data) ? $data + $default : $default;
    }

    /** @param array<string,mixed> $collection */
    private function saveCollection(array $collection): void
    {
        $dir = $this->projectRoot . '/.waypoint';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RpcException(-32050, 'cannot create .waypoint directory');
        }
        if (@file_put_contents($this->waypointFile('api.json'), json_encode($collection, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) === false) {
            throw new RpcException(-32051, 'cannot write .waypoint/api.json');
        }
    }

    /**
     * Plain external HTTP call, run server-side (no CORS). No instrumentation —
     * this is the "just hit my running dev server" target.
     *
     * @param array<string,mixed> $query
     * @param array<string,string> $headers
     * @return array{ok:bool,captured:bool,response?:array,error?:string}
     */
    private function externalSend(string $method, string $url, array $query, array $headers, ?string $body): array
    {
        if ($url === '') {
            throw new RpcException(-32052, 'external send requires a url');
        }
        if ($query !== []) {
            $url .= (str_contains($url, '?') ? '&' : '?') . http_build_query($query);
        }
        $headerLines = [];
        foreach ($headers as $name => $value) {
            $headerLines[] = $name . ': ' . $value;
        }

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => true,
            CURLOPT_HTTPHEADER => $headerLines,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_FOLLOWLOCATION => true,
        ]);
        if ($body !== null && $body !== '') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $start = microtime(true);
        $raw = curl_exec($ch);
        $durationMs = round((microtime(true) - $start) * 1000, 2);
        if ($raw === false) {
            $err = curl_error($ch);
            curl_close($ch);
            return ['ok' => false, 'captured' => false, 'error' => "external request failed: {$err}"];
        }

        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        $contentType = (string) (curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: 'text/plain');
        curl_close($ch);

        $rawHeaders = substr((string) $raw, 0, $headerSize);
        $responseBody = substr((string) $raw, $headerSize);
        $respHeaders = [];
        foreach (explode("\r\n", trim($rawHeaders)) as $line) {
            if (str_contains($line, ':')) {
                [$n, $v] = explode(':', $line, 2);
                $respHeaders[trim($n)] = trim($v);
            }
        }

        return ['ok' => true, 'captured' => false, 'response' => [
            'status' => $status,
            'headers' => $respHeaders,
            'body' => $responseBody,
            'contentType' => $contentType,
            'durationMs' => $durationMs,
        ]];
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
