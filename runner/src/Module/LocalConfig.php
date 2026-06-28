<?php

declare(strict_types=1);

namespace Waypoint\Runner\Module;

/**
 * Per-user, NOT-committed project settings — `.waypoint/local.json` (the personal
 * tier alongside the shared `config.json`). Holds machine/dev-specific things like
 * the probe endpoint + its secret. write() also drops a `.waypoint/.gitignore` so
 * `local.json` never gets committed.
 */
final class LocalConfig
{
    public static function path(string $root): string
    {
        return rtrim($root, '/') . '/.waypoint/local.json';
    }

    /** @return array<string,mixed> */
    public static function read(string $root): array
    {
        $file = self::path($root);
        if (!is_file($file)) {
            return [];
        }
        $data = json_decode((string) @file_get_contents($file), true);
        return is_array($data) ? $data : [];
    }

    /** @param array<string,mixed> $data */
    public static function write(string $root, array $data): bool
    {
        $dir = rtrim($root, '/') . '/.waypoint';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return false;
        }
        // Keep the personal file out of version control.
        $gitignore = $dir . '/.gitignore';
        if (!is_file($gitignore)) {
            @file_put_contents($gitignore, "local.json\n");
        }
        return @file_put_contents(self::path($root), json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) !== false;
    }
}
