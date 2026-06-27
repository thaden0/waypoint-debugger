<?php

declare(strict_types=1);

namespace Waypoint\Runner\Module;

/**
 * Project settings shared via the app-file `.waypoint/config.json` — which
 * framework module to use (or auto-detect) and which providers to override
 * (e.g. swap the ORM from Eloquent to Doctrine independent of the framework).
 * Committed with the repo so a team shares the choice.
 */
final class ProjectConfig
{
    public static function path(string $root): string
    {
        return rtrim($root, '/') . '/.waypoint/config.json';
    }

    /** @return array{module:?string,providers:array{orm:?string,routes:?string}} */
    public static function read(string $root): array
    {
        $default = ['module' => null, 'providers' => ['orm' => null, 'routes' => null]];
        $file = self::path($root);
        if (!is_file($file)) {
            return $default;
        }
        $data = json_decode((string) @file_get_contents($file), true);
        if (!is_array($data)) {
            return $default;
        }
        return [
            'module' => $data['module'] ?? null,
            'providers' => [
                'orm' => $data['providers']['orm'] ?? null,
                'routes' => $data['providers']['routes'] ?? null,
            ],
        ];
    }

    /** @param array{module:?string,providers:array{orm:?string,routes:?string}} $config */
    public static function write(string $root, array $config): bool
    {
        $dir = rtrim($root, '/') . '/.waypoint';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return false;
        }
        $normalized = [
            'module' => $config['module'] ?? null,
            'providers' => [
                'orm' => $config['providers']['orm'] ?? null,
                'routes' => $config['providers']['routes'] ?? null,
            ],
        ];
        return @file_put_contents(self::path($root), json_encode($normalized, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) !== false;
    }
}
