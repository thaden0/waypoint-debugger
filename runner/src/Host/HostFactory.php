<?php

declare(strict_types=1);

namespace Waypoint\Runner\Host;

/**
 * Picks the host for a project root. Laravel is detected by its bootstrap file;
 * anything else gets the BareHost so the tool still runs. (Identifying the app
 * is a heuristic the user can override — the same posture as marking which
 * docker service is "the PHP runner".)
 */
final class HostFactory
{
    public static function for(string $root, ?string $force = null): HostInterface
    {
        $root = rtrim($root, '/');

        if ($force === 'bare') {
            return new BareHost($root);
        }
        if ($force === 'laravel' || self::looksLikeLaravel($root)) {
            return new LaravelHost($root);
        }
        return new BareHost($root);
    }

    public static function looksLikeLaravel(string $root): bool
    {
        return is_file($root . '/bootstrap/app.php')
            && is_file($root . '/artisan');
    }
}
