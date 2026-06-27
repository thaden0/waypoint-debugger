<?php

declare(strict_types=1);

namespace Waypoint\Runner\Docker;

use Symfony\Component\Yaml\Yaml;

/**
 * Parses a docker-compose file and classifies its services. Docker mode lifts the
 * runner OUT of the container set: we bring up the dependency services (db, redis,
 * …) and point our host-side runner at them, while the app/web services fall away
 * (the runner serves HTTP directly). To do that we first need to know which
 * service is "the PHP app" (the one we replace) vs. which are dependencies (the
 * ones we bring up) — a heuristic the user can override.
 */
final class ComposeProject
{
    private const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

    /** image substrings that mark a backing dependency we bring up. */
    private const DEPENDENCY_IMAGES = [
        'mysql', 'mariadb', 'percona', 'postgres', 'postgis', 'redis', 'valkey', 'keydb',
        'memcached', 'mongo', 'rabbitmq', 'elasticsearch', 'opensearch', 'meilisearch',
        'minio', 'mailpit', 'mailhog', 'nats', 'kafka', 'soketi',
    ];

    /** image substrings / command markers that mark the PHP app. */
    private const APP_IMAGE_HINTS = ['php', 'laravel', 'frankenphp', 'octane', 'roadrunner', 'serversideup', 'webdevops'];
    private const APP_COMMAND_HINTS = ['artisan', 'php-fpm', 'octane', 'frankenphp', 'roadrunner'];
    private const WEB_IMAGES = ['nginx', 'caddy', 'apache', 'httpd', 'traefik'];

    /** @param array<string,mixed> $parsed */
    private function __construct(public readonly string $path, private array $parsed)
    {
    }

    public static function find(string $root): ?string
    {
        foreach (self::COMPOSE_NAMES as $name) {
            $candidate = rtrim($root, '/') . '/' . $name;
            if (is_file($candidate)) {
                return $candidate;
            }
        }
        return null;
    }

    public static function load(string $path): self
    {
        $parsed = Yaml::parseFile($path);
        if (!is_array($parsed)) {
            throw new \RuntimeException("compose file is not a mapping: {$path}");
        }
        return new self($path, $parsed);
    }

    /**
     * @return array<int,array{
     *   name:string, image:?string, build:bool, command:?string, role:string,
     *   ports:array<int,array{published:?int,target:int,host_ip:?string,protocol:string}>,
     *   environment:array<string,string>, depends_on:array<int,string>
     * }>
     */
    public function services(): array
    {
        $out = [];
        foreach (($this->parsed['services'] ?? []) as $name => $def) {
            $def = is_array($def) ? $def : [];
            $image = isset($def['image']) ? (string) $def['image'] : null;
            $build = isset($def['build']);
            $command = $this->stringifyCommand($def['command'] ?? null);
            $ports = $this->parsePorts($def['ports'] ?? []);
            $env = $this->parseEnvironment($def['environment'] ?? []);

            $out[] = [
                'name' => (string) $name,
                'image' => $image,
                'build' => $build,
                'command' => $command,
                'role' => $this->classify($image, $build, $command),
                'ports' => $ports,
                'environment' => $env,
                'depends_on' => $this->parseDependsOn($def['depends_on'] ?? []),
            ];
        }
        return $out;
    }

    /** @return array<int,string> service names classified as a dependency */
    public function dependencyServices(): array
    {
        return array_values(array_map(
            static fn (array $s) => $s['name'],
            array_filter($this->services(), static fn (array $s) => $s['role'] === 'dependency')
        ));
    }

    /** @return array<int,string> service names classified as the PHP app */
    public function appServices(): array
    {
        return array_values(array_map(
            static fn (array $s) => $s['name'],
            array_filter($this->services(), static fn (array $s) => $s['role'] === 'app')
        ));
    }

    /** Default compose network name (project_default), used for the network-join path. */
    public function defaultNetworkName(string $projectName): string
    {
        $networks = $this->parsed['networks'] ?? [];
        if (is_array($networks)) {
            foreach ($networks as $name => $def) {
                if (is_array($def) && ($def['external'] ?? false)) {
                    return is_array($def) && isset($def['name']) ? (string) $def['name'] : (string) $name;
                }
            }
        }
        return $projectName . '_default';
    }

    private function classify(?string $image, bool $build, ?string $command): string
    {
        $img = strtolower($image ?? '');

        foreach (self::DEPENDENCY_IMAGES as $dep) {
            if ($img !== '' && str_contains($img, $dep)) {
                return 'dependency';
            }
        }
        foreach (self::WEB_IMAGES as $web) {
            if ($img !== '' && str_contains($img, $web)) {
                return 'web';
            }
        }
        if ($build) {
            return 'app';
        }
        foreach (self::APP_IMAGE_HINTS as $hint) {
            if ($img !== '' && str_contains($img, $hint)) {
                return 'app';
            }
        }
        $cmd = strtolower($command ?? '');
        foreach (self::APP_COMMAND_HINTS as $hint) {
            if ($cmd !== '' && str_contains($cmd, $hint)) {
                return 'app';
            }
        }
        return 'unknown';
    }

    /** @return array<int,array{published:?int,target:int,host_ip:?string,protocol:string}> */
    private function parsePorts(mixed $ports): array
    {
        if (!is_array($ports)) {
            return [];
        }
        $out = [];
        foreach ($ports as $port) {
            if (is_array($port)) {
                // long form
                $out[] = [
                    'published' => isset($port['published']) ? (int) $port['published'] : null,
                    'target' => (int) ($port['target'] ?? 0),
                    'host_ip' => isset($port['host_ip']) ? (string) $port['host_ip'] : null,
                    'protocol' => (string) ($port['protocol'] ?? 'tcp'),
                ];
                continue;
            }
            $out[] = $this->parseShortPort((string) $port);
        }
        return array_values(array_filter($out, static fn ($p) => $p['target'] > 0));
    }

    /** @return array{published:?int,target:int,host_ip:?string,protocol:string} */
    private function parseShortPort(string $spec): array
    {
        $protocol = 'tcp';
        if (str_contains($spec, '/')) {
            [$spec, $protocol] = explode('/', $spec, 2);
        }
        $parts = explode(':', $spec);
        // forms: "target" | "published:target" | "host_ip:published:target"
        $hostIp = null;
        $published = null;
        $target = null;
        if (count($parts) === 1) {
            $target = (int) $parts[0];
        } elseif (count($parts) === 2) {
            $published = $parts[0] === '' ? null : (int) $parts[0];
            $target = (int) $parts[1];
        } else {
            $hostIp = $parts[0];
            $published = $parts[1] === '' ? null : (int) $parts[1];
            $target = (int) $parts[2];
        }
        return ['published' => $published, 'target' => (int) $target, 'host_ip' => $hostIp, 'protocol' => $protocol];
    }

    /** @return array<string,string> */
    private function parseEnvironment(mixed $env): array
    {
        $out = [];
        if (is_array($env) && array_is_list($env)) {
            foreach ($env as $line) {
                $line = (string) $line;
                if (str_contains($line, '=')) {
                    [$k, $v] = explode('=', $line, 2);
                    $out[$k] = $v;
                }
            }
        } elseif (is_array($env)) {
            foreach ($env as $k => $v) {
                $out[(string) $k] = $v === null ? '' : (string) $v;
            }
        }
        return $out;
    }

    /** @return array<int,string> */
    private function parseDependsOn(mixed $dependsOn): array
    {
        if (is_array($dependsOn) && array_is_list($dependsOn)) {
            return array_map('strval', $dependsOn);
        }
        if (is_array($dependsOn)) {
            return array_map('strval', array_keys($dependsOn));
        }
        return [];
    }

    private function stringifyCommand(mixed $command): ?string
    {
        if (is_array($command)) {
            return implode(' ', array_map('strval', $command));
        }
        return $command === null ? null : (string) $command;
    }
}
