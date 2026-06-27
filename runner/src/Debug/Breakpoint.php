<?php

declare(strict_types=1);

namespace Waypoint\Runner\Debug;

use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Rpc\Notifier;

/**
 * Runtime side of a breakpoint. An injected hook calls hit() at the breakpoint
 * line with the full local scope (get_defined_vars()), giving the variable-level
 * inspection a debugger offers — without a step-debugger.
 *
 *  - "halt"  : capture scope, stream the hit, then throw BreakpointHalt to stop
 *              the run there (run-to-breakpoint). Continue = re-run; change a var
 *              = swap + re-run, consistent with the rest of the tool.
 *  - "trace" : capture and stream every hit, but keep running (logpoint-style).
 */
final class Breakpoint
{
    private static string $mode = 'halt';
    /** @var array<int,array<string,mixed>> */
    private static array $hits = [];
    private static bool $enabled = true;

    public static function setMode(string $mode): void
    {
        self::$mode = $mode === 'trace' ? 'trace' : 'halt';
    }

    public static function setEnabled(bool $on): void
    {
        self::$enabled = $on;
    }

    public static function reset(): void
    {
        self::$hits = [];
    }

    /** @return array<int,array<string,mixed>> */
    public static function hits(): array
    {
        return self::$hits;
    }

    /**
     * @param array<string,mixed> $vars  get_defined_vars() at the breakpoint line
     */
    public static function hit(string $id, array $vars, ?object $receiver = null): void
    {
        if (!self::$enabled) {
            return;
        }

        $scope = [];
        foreach ($vars as $name => $value) {
            $scope[$name] = self::describe($value);
        }
        if ($receiver !== null) {
            $scope['this'] = self::describe($receiver);
        }

        $hit = ['id' => $id, 'scope' => $scope];
        self::$hits[] = $hit;
        Notifier::notify('breakpoint.hit', $hit);

        if (self::$mode === 'halt') {
            throw new BreakpointHalt($id, $scope);
        }
    }

    /** Display-only view of a value (no reconstruction blob). */
    private static function describe(mixed $value): array
    {
        $snapshot = Recorder::snapshotValue($value);
        unset($snapshot['blob']);
        return $snapshot;
    }
}
