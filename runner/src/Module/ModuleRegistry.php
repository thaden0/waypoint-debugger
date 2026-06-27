<?php

declare(strict_types=1);

namespace Waypoint\Runner\Module;

/**
 * Discovers framework modules from `modules/*\/module.json` manifests and resolves
 * one for a project root by its `detect` globs (most-specific wins; an empty
 * detect set is the fallback, e.g. bare). Adding a framework = drop a module
 * directory with a manifest; no edit here.
 */
final class ModuleRegistry
{
    /** @var list<array{id:string,detect:list<string>,class:string,role:string,capabilities:list<string>}> */
    private array $modules = [];

    public function __construct(string $modulesDir)
    {
        foreach (glob(rtrim($modulesDir, '/') . '/*/module.json') ?: [] as $file) {
            $m = json_decode((string) @file_get_contents($file), true);
            if (!is_array($m) || ($m['kind'] ?? '') !== 'framework' || empty($m['provides']['module'])) {
                continue;
            }
            $this->modules[] = [
                'id' => (string) ($m['id'] ?? ''),
                'detect' => array_values($m['detect'] ?? []),
                'class' => (string) $m['provides']['module'],
                'role' => (string) ($m['role'] ?? 'backend'),
                'capabilities' => array_values($m['capabilities'] ?? []),
            ];
        }
        // Most-specific first; empty-detect modules (fallbacks) sink to the bottom.
        usort($this->modules, static fn ($a, $b): int => count($b['detect']) <=> count($a['detect']));
    }

    public static function default(): self
    {
        return new self(dirname(__DIR__, 2) . '/modules');
    }

    public function resolve(string $root, ?string $force = null): FrameworkModule
    {
        $root = rtrim($root, '/');

        if ($force !== null && $force !== '') {
            foreach ($this->modules as $m) {
                if ($m['id'] === $force) {
                    return $this->make($m['class'], $root);
                }
            }
        }
        foreach ($this->modules as $m) {
            if ($m['detect'] !== [] && $this->detects($root, $m['detect'])) {
                return $this->make($m['class'], $root);
            }
        }
        foreach ($this->modules as $m) {
            if ($m['detect'] === []) {
                return $this->make($m['class'], $root);
            }
        }
        return new \Waypoint\Modules\Bare\BareModule($root);
    }

    /** @return list<array{id:string,detect:list<string>,class:string,role:string,capabilities:list<string>}> */
    public function manifests(): array
    {
        return $this->modules;
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

    private function make(string $class, string $root): FrameworkModule
    {
        /** @var FrameworkModule */
        return new $class($root);
    }
}
