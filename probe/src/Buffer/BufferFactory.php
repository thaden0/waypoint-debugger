<?php

declare(strict_types=1);

namespace Waypoint\Probe\Buffer;

/**
 * Pick the buffer: the app's cache store when available (Redis/DB/file), else a
 * plain JSON file — the always-available fallback.
 */
final class BufferFactory
{
    /** @param array<string,mixed> $config */
    public static function make(array $config): Buffer
    {
        $max = (int) ($config['max'] ?? 200);
        $ttl = (int) ($config['ttl'] ?? 3600);
        $driver = $config['driver'] ?? 'cache';

        if ($driver === 'cache' && function_exists('cache')) {
            try {
                return new CacheBuffer(cache()->store(), $max, $ttl);
            } catch (\Throwable) {
                // cache not configured — fall through to file
            }
        }
        $file = $config['file'] ?? sys_get_temp_dir() . '/waypoint-probe.json';
        return new FileBuffer((string) $file, $max, $ttl);
    }
}
