<?php

declare(strict_types=1);

namespace Waypoint\Runner\Debug;

use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Rpc\Notifier;

/**
 * Runtime side of a breakpoint. An injected hook calls hit() at the breakpoint
 * line with the full local scope (get_defined_vars()).
 *
 *  - "halt"        : capture scope, stream the hit, then throw BreakpointHalt to
 *                    stop the run there (run-to-breakpoint; continue = re-run).
 *  - "trace"       : capture + stream every hit, keep running (logpoint-style).
 *  - "interactive" : capture, then PAUSE — call the pause handler, which blocks
 *                    until the user sends continue/step/stop. This is the real
 *                    pause/resume: the call stack stays live and resumes in place.
 *                    step() (injected before every statement) pauses on the next
 *                    line while stepping.
 */
final class Breakpoint
{
    private static string $mode = 'halt';
    /** @var array<int,array<string,mixed>> */
    private static array $hits = [];
    private static bool $enabled = true;

    /** @var null|callable(string,int,array):string returns the next command */
    private static $pauseHandler = null;
    private static bool $stepping = false;

    public static function setMode(string $mode): void
    {
        self::$mode = in_array($mode, ['trace', 'interactive'], true) ? $mode : 'halt';
    }

    public static function setPauseHandler(?callable $handler): void
    {
        self::$pauseHandler = $handler;
    }

    public static function setStepping(bool $on): void
    {
        self::$stepping = $on;
    }

    public static function setEnabled(bool $on): void
    {
        self::$enabled = $on;
    }

    public static function reset(): void
    {
        self::$hits = [];
        self::$stepping = false;
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
        $scope = self::scope($vars, $receiver);
        $hit = ['id' => $id, 'scope' => $scope];
        self::$hits[] = $hit;
        Notifier::notify('breakpoint.hit', $hit);

        if (self::$mode === 'interactive') {
            self::pause($id, self::lineFromId($id), $scope);
        } elseif (self::$mode === 'halt') {
            throw new BreakpointHalt($id, $scope);
        }
    }

    /**
     * Step probe, injected before every statement. Pauses on the next statement
     * while the user is stepping; otherwise a cheap no-op flag check.
     *
     * @param array<string,mixed> $vars
     */
    public static function step(int $line, array $vars, ?object $receiver = null): void
    {
        if (!self::$enabled || self::$mode !== 'interactive' || !self::$stepping) {
            return;
        }
        self::pause('step:' . $line, $line, self::scope($vars, $receiver));
    }

    /**
     * Block until the user sends the next command. The handler emits the pause to
     * the UI and reads back continue/step/stop.
     *
     * @param array<string,mixed> $scope
     */
    private static function pause(string $id, int $line, array $scope): void
    {
        if (self::$pauseHandler === null) {
            return;
        }
        $command = (self::$pauseHandler)($id, $line, $scope);
        if ($command === 'stop') {
            throw new StopRun();
        }
        self::$stepping = ($command === 'step');
    }

    /** @return array<string,mixed> */
    private static function scope(array $vars, ?object $receiver): array
    {
        $scope = [];
        foreach ($vars as $name => $value) {
            $scope[$name] = self::describe($value);
        }
        if ($receiver !== null) {
            $scope['this'] = self::describe($receiver);
        }
        return $scope;
    }

    private static function lineFromId(string $id): int
    {
        return str_contains($id, ':') ? (int) substr($id, strrpos($id, ':') + 1) : 0;
    }

    /** Display-only view of a value (no reconstruction blob). */
    private static function describe(mixed $value): array
    {
        $snapshot = Recorder::snapshotValue($value);
        unset($snapshot['blob']);
        return $snapshot;
    }
}
