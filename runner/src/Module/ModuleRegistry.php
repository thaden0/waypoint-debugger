<?php

declare(strict_types=1);

namespace Waypoint\Runner\Module;

/**
 * Discovers modules from `modules/*\/module.json` manifests and resolves the
 * framework module for a project root — by explicit force, then `.waypoint`
 * config, then `detect` globs (most-specific wins; empty detect = fallback).
 * Also aggregates the providers a project may swap in (ORM/route) and the
 * language manifests the launcher uses. Adding a framework/provider = drop a
 * module directory with a manifest; no edit here.
 */
final class ModuleRegistry
{
    /** @var list<array{id:string,detect:list<string>,class:string,role:string,capabilities:list<string>}> */
    private array $frameworks = [];
    /** @var list<array{id:string,role:string,extensions:list<string>,monaco:?string,runner:?array}> */
    private array $languages = [];
    /** @var array<string,list<array{id:string,class:string,framework:string,default:bool}>> capability => providers */
    private array $providers = ['orm' => [], 'routes' => []];

    public function __construct(string $modulesDir)
    {
        foreach (glob(rtrim($modulesDir, '/') . '/*/module.json') ?: [] as $file) {
            $m = json_decode((string) @file_get_contents($file), true);
            if (!is_array($m) || empty($m['id'])) {
                continue;
            }
            $kind = $m['kind'] ?? '';
            if ($kind === 'framework' && !empty($m['provides']['module'])) {
                $this->frameworks[] = [
                    'id' => (string) $m['id'],
                    'detect' => array_values($m['detect'] ?? []),
                    'class' => (string) $m['provides']['module'],
                    'role' => (string) ($m['role'] ?? 'backend'),
                    'capabilities' => array_values($m['capabilities'] ?? []),
                ];
                foreach (['orm', 'routes'] as $cap) {
                    foreach ($m['provides'][$cap] ?? [] as $p) {
                        $this->providers[$cap][] = [
                            'id' => (string) ($p['id'] ?? ''),
                            'class' => (string) ($p['class'] ?? ''),
                            'framework' => (string) $m['id'],
                            'default' => (bool) ($p['default'] ?? false),
                        ];
                    }
                }
            } elseif ($kind === 'language') {
                $this->languages[] = [
                    'id' => (string) $m['id'],
                    'role' => (string) ($m['role'] ?? 'backend'),
                    'extensions' => array_values($m['extensions'] ?? []),
                    'monaco' => $m['monaco'] ?? null,
                    'runner' => $m['runner'] ?? null,
                ];
            }
        }
        usort($this->frameworks, static fn ($a, $b): int => count($b['detect']) <=> count($a['detect']));
    }

    public static function default(): self
    {
        return new self(dirname(__DIR__, 2) . '/modules');
    }

    /** Resolve the framework module for a root, honoring force > project config > detection. */
    public function resolve(string $root, ?string $force = null): FrameworkModule
    {
        $root = rtrim($root, '/');
        $config = ProjectConfig::read($root);
        $id = $force ?: ($config['module'] ?? $this->detect($root));
        $base = $this->makeModule($id, $root);
        return new ConfiguredModule($base, $this, $root, $config['providers']);
    }

    /** The framework id auto-detected for a root (ignoring config/force). */
    public function detect(string $root): ?string
    {
        $root = rtrim($root, '/');
        foreach ($this->frameworks as $m) {
            if ($m['detect'] !== [] && $this->detects($root, $m['detect'])) {
                return $m['id'];
            }
        }
        foreach ($this->frameworks as $m) {
            if ($m['detect'] === []) {
                return $m['id'];
            }
        }
        return null;
    }

    public function providerClass(string $capability, string $id): ?string
    {
        foreach ($this->providers[$capability] ?? [] as $p) {
            if ($p['id'] === $id) {
                return $p['class'];
            }
        }
        return null;
    }

    /** @return list<array{id:string,detect:list<string>,role:string,capabilities:list<string>}> */
    public function availableModules(): array
    {
        return array_map(static fn ($m) => [
            'id' => $m['id'], 'detect' => $m['detect'], 'role' => $m['role'], 'capabilities' => $m['capabilities'],
        ], $this->frameworks);
    }

    /** @return list<array{id:string,role:string,extensions:list<string>,monaco:?string}> */
    public function availableLanguages(): array
    {
        return array_map(static fn ($l) => [
            'id' => $l['id'], 'role' => $l['role'], 'extensions' => $l['extensions'], 'monaco' => $l['monaco'],
        ], $this->languages);
    }

    /** @return array<string,list<array{id:string,framework:string}>> */
    public function availableProviders(): array
    {
        $out = [];
        foreach ($this->providers as $cap => $list) {
            $out[$cap] = array_map(static fn ($p) => ['id' => $p['id'], 'framework' => $p['framework']], $list);
        }
        return $out;
    }

    private function makeModule(?string $id, string $root): FrameworkModule
    {
        foreach ($this->frameworks as $m) {
            if ($m['id'] === $id) {
                return new ($m['class'])($root);
            }
        }
        foreach ($this->frameworks as $m) {
            if ($m['detect'] === []) {
                return new ($m['class'])($root);
            }
        }
        return new \Waypoint\Modules\Bare\BareModule($root);
    }

    /** @param list<string> $files */
    private function detects(string $root, array $files): bool
    {
        foreach ($files as $f) {
            if (!file_exists($root . '/' . $f)) {
                return false;
            }
        }
        return true;
    }
}
