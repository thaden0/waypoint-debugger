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

    /** @return array{module:?string,providers:array{orm:?string,routes:?string},docker:array{compose:?string}} */
    public static function read(string $root): array
    {
        $file = self::path($root);
        if (!is_file($file)) {
            return self::normalize([]);
        }
        $data = json_decode((string) @file_get_contents($file), true);
        return self::normalize(is_array($data) ? $data : []);
    }

    public static function write(string $root, array $config): bool
    {
        $dir = rtrim($root, '/') . '/.waypoint';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return false;
        }
        return @file_put_contents(self::path($root), json_encode(self::normalize($config), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) !== false;
    }

    /** @param array<string,mixed> $data */
    private static function normalize(array $data): array
    {
        return [
            'module' => $data['module'] ?? null,
            'providers' => [
                'orm' => $data['providers']['orm'] ?? null,
                'routes' => $data['providers']['routes'] ?? null,
            ],
            'docker' => [
                'compose' => $data['docker']['compose'] ?? null,
            ],
            'httpMocks' => is_array($data['httpMocks'] ?? null) ? array_values($data['httpMocks']) : [],
        ];
    }
}
