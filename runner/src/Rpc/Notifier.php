<?php

declare(strict_types=1);

namespace Waypoint\Runner\Rpc;

/**
 * Server->client push channel for JSON-RPC notifications (no id). The WebSocket
 * server registers a sink here; capture hooks and run progress emit through it so
 * the UI ledger/console update live as a run proceeds.
 */
final class Notifier
{
    /** @var null|callable(array):void */
    private static $sink = null;

    public static function setSink(?callable $sink): void
    {
        self::$sink = $sink;
    }

    public static function notify(string $method, array $params): void
    {
        if (self::$sink !== null) {
            (self::$sink)(['jsonrpc' => '2.0', 'method' => $method, 'params' => $params]);
        }
    }

    public static function hasSink(): bool
    {
        return self::$sink !== null;
    }
}
