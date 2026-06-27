<?php

declare(strict_types=1);

namespace Waypoint\Runner\Workspace;

use Waypoint\Runner\Module\ModuleRegistry;

/**
 * The user-global list of known projects, persisted to `~/.waypoint/projects.json`
 * (this machine, not committed). Backs the header project picker — opening a path
 * registers it; the picker lists from here. Each entry carries the framework
 * module detected for that project so the picker can show it.
 */
final class Workspace
{
    public function __construct(private ModuleRegistry $registry)
    {
    }

    private function file(): string
    {
        $home = getenv('HOME') ?: getenv('USERPROFILE') ?: sys_get_temp_dir();
        return rtrim($home, '/') . '/.waypoint/projects.json';
    }

    /** @return list<array{path:string,name:string,module:?string,lastOpened:int}> */
    public function projects(): array
    {
        $file = $this->file();
        if (!is_file($file)) {
            return [];
        }
        $data = json_decode((string) @file_get_contents($file), true);
        $list = is_array($data['projects'] ?? null) ? $data['projects'] : [];
        // Drop entries whose directory no longer exists; most-recent first.
        $list = array_values(array_filter($list, static fn ($p) => is_string($p['path'] ?? null) && is_dir($p['path'])));
        usort($list, static fn ($a, $b) => ($b['lastOpened'] ?? 0) <=> ($a['lastOpened'] ?? 0));
        return $list;
    }

    /** Add or refresh a project (re-detects its module + bumps lastOpened). */
    public function add(string $path): ?array
    {
        $path = rtrim($path, '/');
        if ($path === '' || !is_dir($path)) {
            return null;
        }
        $entry = [
            'path' => $path,
            'name' => basename($path),
            'module' => $this->registry->detect($path),
            'lastOpened' => time(),
        ];
        $list = array_values(array_filter($this->projects(), static fn ($p) => ($p['path'] ?? '') !== $path));
        array_unshift($list, $entry);
        $this->write($list);
        return $entry;
    }

    public function remove(string $path): void
    {
        $path = rtrim($path, '/');
        $this->write(array_values(array_filter($this->projects(), static fn ($p) => ($p['path'] ?? '') !== $path)));
    }

    /** @param list<array> $list */
    private function write(array $list): void
    {
        $dir = dirname($this->file());
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return;
        }
        @file_put_contents($this->file(), json_encode(['projects' => $list], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }
}
