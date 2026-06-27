<?php

declare(strict_types=1);

namespace Waypoint\Runner\Support;

/**
 * A JSON-safe, depth- and size-capped rendering of an arbitrary PHP value, used
 * to send query results / invocation outcomes to the UI. Leans on toArray() /
 * JsonSerializable so Eloquent models and Collections render as their data — the
 * same trick the replay what-if preview uses, shared here for the ORM console.
 */
final class Preview
{
    public static function render(mixed $v, int $depth = 0): mixed
    {
        if ($v === null || is_scalar($v)) {
            return $v;
        }
        if ($depth >= 5) {
            return ['__truncated' => get_debug_type($v)];
        }
        if (is_array($v)) {
            $out = [];
            $i = 0;
            foreach ($v as $k => $vv) {
                if ($i++ >= 200) {
                    $out['__more'] = count($v) - 200;
                    break;
                }
                $out[$k] = self::render($vv, $depth + 1);
            }
            return $out;
        }
        if (is_object($v)) {
            if (method_exists($v, 'toArray')) {
                try {
                    return self::render($v->toArray(), $depth + 1);
                } catch (\Throwable) {
                    // fall through
                }
            }
            if ($v instanceof \JsonSerializable) {
                return self::render($v->jsonSerialize(), $depth + 1);
            }
            return ['__type' => get_class($v), 'value' => self::render(get_object_vars($v), $depth + 1)];
        }
        return ['__type' => get_debug_type($v)];
    }

    /** A short, human one-liner describing the type of a value (for the console echo). */
    public static function describe(mixed $v): string
    {
        if ($v === null) {
            return 'null';
        }
        if (is_bool($v)) {
            return 'bool';
        }
        if (is_scalar($v)) {
            return get_debug_type($v);
        }
        if (is_array($v)) {
            return 'array(' . count($v) . ')';
        }
        if (is_object($v)) {
            $class = get_class($v);
            if ($v instanceof \Countable) {
                return $class . '(' . count($v) . ')';
            }
            return $class;
        }
        return get_debug_type($v);
    }
}
