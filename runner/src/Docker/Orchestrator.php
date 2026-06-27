<?php

declare(strict_types=1);

namespace Waypoint\Runner\Docker;

/**
 * Orchestrates docker mode: bring up the dependency services, read their LIVE
 * published ports, and produce the env overrides that point our host-side runner
 * at them. The runner replaces the app/web services for the path it drives, so
 * those are never started here.
 *
 * Reach is resolved per dependency:
 *  - "published": the dep maps a host port -> connect to 127.0.0.1:<hostPort>.
 *    (Needs a DB_HOST -> 127.0.0.1 override, which we generate.)
 *  - "network-join": the dep publishes nothing -> a host-side runner can't reach
 *    it; flag that joining the compose network is required (the robust path).
 */
final class Orchestrator
{
    private ComposeProject $compose;

    public function __construct(
        private string $composePath,
        private string $projectName,
    ) {
        $this->compose = ComposeProject::load($composePath);
    }

    public static function forRoot(string $root): ?self
    {
        $path = ComposeProject::find($root);
        if ($path === null) {
            return null;
        }
        $project = preg_replace('/[^a-z0-9]/', '', strtolower(basename($root))) ?: 'app';
        return new self($path, $project);
    }

    /**
     * Static analysis only — no docker calls. Safe to run on connect.
     *
     * @return array<string,mixed>
     */
    public function scan(): array
    {
        $services = $this->compose->services();
        $reach = [];
        foreach ($services as $s) {
            if ($s['role'] === 'dependency') {
                $reach[$s['name']] = $this->resolveReach($s);
            }
        }
        return [
            'compose' => $this->composePath,
            'project' => $this->projectName,
            'services' => $services,
            'app' => $this->compose->appServices(),
            'dependencies' => $this->compose->dependencyServices(),
            'reach' => $reach,
            'network' => $this->compose->defaultNetworkName($this->projectName),
        ];
    }

    /**
     * Bring up the given dependency services (default: all classified as deps),
     * read their live published ports, and compute env overrides.
     *
     * @param array<int,string>|null $only
     * @return array{ok:bool,broughtUp:array<int,string>,targets:array<int,array<string,mixed>>,env:array<string,string>,warnings:array<int,string>,error?:string}
     */
    public function up(?array $only = null): array
    {
        $deps = $only ?? $this->compose->dependencyServices();
        if ($deps === []) {
            return ['ok' => true, 'broughtUp' => [], 'targets' => [], 'env' => [], 'warnings' => ['no dependency services found in compose']];
        }

        [$code, , $err] = $this->dockerCompose(array_merge(['up', '-d'], $deps), 180);
        if ($code !== 0) {
            return ['ok' => false, 'broughtUp' => [], 'targets' => [], 'env' => [], 'warnings' => [], 'error' => trim($err) ?: 'docker compose up failed'];
        }

        $servicesByName = [];
        foreach ($this->compose->services() as $s) {
            $servicesByName[$s['name']] = $s;
        }

        $targets = [];
        $env = [];
        $warnings = [];
        foreach ($deps as $dep) {
            $svc = $servicesByName[$dep] ?? null;
            if ($svc === null) {
                continue;
            }
            $containerPort = $svc['ports'][0]['target'] ?? $this->defaultPortFor($svc['image']);
            if ($containerPort === null) {
                $warnings[] = "{$dep}: no port to resolve";
                continue;
            }
            $hostPort = $this->livePublishedPort($dep, $containerPort);
            if ($hostPort === null) {
                $warnings[] = "{$dep}: not published on the host — network-join required to reach it";
                continue;
            }
            $target = ['service' => $dep, 'image' => $svc['image'], 'host' => '127.0.0.1', 'port' => $hostPort, 'containerPort' => $containerPort];
            $targets[] = $target;
            $env = array_merge($env, $this->envFor($svc, $target));
        }

        return ['ok' => true, 'broughtUp' => $deps, 'targets' => $targets, 'env' => $env, 'warnings' => $warnings];
    }

    /**
     * Compute the Laravel env overrides for a named dependency at a host port —
     * exposed for deterministic testing of the mapping without bringing docker up.
     *
     * @return array<string,string>
     */
    public function envForService(string $serviceName, int $hostPort, string $host = '127.0.0.1'): array
    {
        foreach ($this->compose->services() as $s) {
            if ($s['name'] === $serviceName) {
                return $this->envFor($s, ['host' => $host, 'port' => $hostPort]);
            }
        }
        return [];
    }

    public function down(): array
    {
        [$code, , $err] = $this->dockerCompose(['down'], 120);
        return ['ok' => $code === 0, 'error' => $code === 0 ? null : trim($err)];
    }

    /** @param array{ports:array,image:?string} $service @return array<string,mixed> */
    private function resolveReach(array $service): array
    {
        foreach ($service['ports'] as $p) {
            if ($p['target'] > 0) {
                return [
                    'mode' => 'published',
                    'host' => '127.0.0.1',
                    'publishedPort' => $p['published'], // null => dynamic, resolved at up time
                    'containerPort' => $p['target'],
                ];
            }
        }
        return [
            'mode' => 'network-join',
            'containerPort' => $this->defaultPortFor($service['image']),
            'note' => 'dependency publishes no host port; join the compose network to reach it by service name',
        ];
    }

    /** Read the actual host port docker assigned (handles dynamic ports too). */
    private function livePublishedPort(string $service, int $containerPort): ?int
    {
        [$code, $out] = $this->dockerCompose(['port', $service, (string) $containerPort], 30);
        if ($code !== 0) {
            return null;
        }
        $out = trim($out);
        if ($out === '' || !str_contains($out, ':')) {
            return null;
        }
        $port = (int) substr($out, strrpos($out, ':') + 1);
        return $port > 0 ? $port : null;
    }

    /** @return array<string,string> */
    private function envFor(array $service, array $target): array
    {
        $img = strtolower($service['image'] ?? '');
        $e = $service['environment'];
        $host = $target['host'];
        $port = (string) $target['port'];

        if (str_contains($img, 'postgres') || str_contains($img, 'postgis')) {
            return [
                'DB_CONNECTION' => 'pgsql', 'DB_HOST' => $host, 'DB_PORT' => $port,
                'DB_DATABASE' => $e['POSTGRES_DB'] ?? 'laravel',
                'DB_USERNAME' => $e['POSTGRES_USER'] ?? 'postgres',
                'DB_PASSWORD' => $e['POSTGRES_PASSWORD'] ?? '',
            ];
        }
        if (str_contains($img, 'mysql') || str_contains($img, 'mariadb') || str_contains($img, 'percona')) {
            return [
                'DB_CONNECTION' => 'mysql', 'DB_HOST' => $host, 'DB_PORT' => $port,
                'DB_DATABASE' => $e['MYSQL_DATABASE'] ?? 'laravel',
                'DB_USERNAME' => $e['MYSQL_USER'] ?? 'root',
                'DB_PASSWORD' => $e['MYSQL_PASSWORD'] ?? ($e['MYSQL_ROOT_PASSWORD'] ?? ''),
            ];
        }
        if (str_contains($img, 'redis') || str_contains($img, 'valkey') || str_contains($img, 'keydb')) {
            return ['REDIS_HOST' => $host, 'REDIS_PORT' => $port];
        }
        if (str_contains($img, 'memcached')) {
            return ['MEMCACHED_HOST' => $host, 'MEMCACHED_PORT' => $port];
        }
        if (str_contains($img, 'mailpit') || str_contains($img, 'mailhog')) {
            return ['MAIL_HOST' => $host, 'MAIL_PORT' => $port];
        }
        if (str_contains($img, 'meilisearch')) {
            return ['MEILISEARCH_HOST' => "http://{$host}:{$port}"];
        }
        return [];
    }

    private function defaultPortFor(?string $image): ?int
    {
        $img = strtolower($image ?? '');
        return match (true) {
            str_contains($img, 'postgres') || str_contains($img, 'postgis') => 5432,
            str_contains($img, 'mysql') || str_contains($img, 'mariadb') || str_contains($img, 'percona') => 3306,
            str_contains($img, 'redis') || str_contains($img, 'valkey') || str_contains($img, 'keydb') => 6379,
            str_contains($img, 'memcached') => 11211,
            str_contains($img, 'mongo') => 27017,
            default => null,
        };
    }

    /**
     * @param array<int,string> $args
     * @return array{0:int,1:string,2:string} [code, stdout, stderr]
     */
    private function dockerCompose(array $args, int $timeoutSec): array
    {
        $cmd = array_merge(['docker', 'compose', '-p', $this->projectName, '-f', $this->composePath], $args);
        $proc = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($proc)) {
            return [1, '', 'failed to spawn docker'];
        }
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $out = '';
        $err = '';
        $deadline = microtime(true) + $timeoutSec;
        do {
            $out .= stream_get_contents($pipes[1]);
            $err .= stream_get_contents($pipes[2]);
            $status = proc_get_status($proc);
            if (!$status['running']) {
                break;
            }
            if (microtime(true) > $deadline) {
                proc_terminate($proc);
                $err .= "\n[timeout after {$timeoutSec}s]";
                break;
            }
            usleep(50000);
        } while (true);
        $out .= stream_get_contents($pipes[1]);
        $err .= stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);
        return [$status['running'] ? 1 : $code, $out, $err];
    }
}
