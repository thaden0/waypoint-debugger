<?php

declare(strict_types=1);

namespace Waypoint\Probe;

use Throwable;

/**
 * The probe's *active* runtime config — the remotely-pushed values (cache) take
 * precedence over the static config file, so the Waypoint tool can toggle the
 * heavy ring-buffer capture and set trigger classes without a redeploy.
 */
final class ProbeConfig
{
    public const CONFIG_KEY = 'waypoint:probe:config';

    /** @return array{ring_buffer:bool,triggers:list<string>} */
    public static function active(): array
    {
        $stored = function_exists('cache') ? cache()->get(self::CONFIG_KEY) : null;
        if (is_array($stored)) {
            return [
                'ring_buffer' => (bool) ($stored['ring_buffer'] ?? false),
                'triggers' => array_values($stored['triggers'] ?? []),
            ];
        }
        return [
            'ring_buffer' => (bool) (function_exists('config') ? config('waypoint-probe.ring_buffer', false) : false),
            'triggers' => array_values(function_exists('config') ? config('waypoint-probe.triggers', []) : []),
        ];
    }

    /** Does this exception match a trigger? (no triggers = match all) */
    public static function triggered(Throwable $e, array $triggers): bool
    {
        if ($triggers === []) {
            return true;
        }
        foreach ($triggers as $t) {
            if ($t !== '' && (str_contains($e::class, $t) || is_a($e, $t))) {
                return true;
            }
        }
        return false;
    }
}
