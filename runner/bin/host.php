<?php

declare(strict_types=1);

/**
 * Resident host process: boots the target app once and serves the control plane
 * over WebSocket. This is the runner-as-host model under plain PHP CLI — the app
 * and the tool share one long-lived process, so capture hooks reach the ledger
 * directly and re-invokes are fast. FrankenPHP worker mode (bin/worker.php) is
 * the drop-in performance upgrade; the logic is identical.
 *
 *   PROJECT_ROOT=/path/to/laravel php bin/host.php
 *   WP_HOST_DRIVER=bare php bin/host.php        # force the frameworkless host
 *
 * Ports: ws://127.0.0.1:9778 (override with WP_WS_PORT).
 */

require __DIR__ . '/../vendor/autoload.php';

use Waypoint\Runner\Docker\Orchestrator;
use Waypoint\Runner\Host\HostFactory;
use Waypoint\Runner\Rpc\Dispatcher;
use Waypoint\Runner\Rpc\MethodRegistry;
use Waypoint\Runner\Rpc\WebSocketServer;

$projectRoot = getenv('PROJECT_ROOT') ?: getcwd();
$force = getenv('WP_HOST_DRIVER') ?: null;
$wsPort = (int) (getenv('WP_WS_PORT') ?: 9778);

// Docker mode: bring up the dependency services and point the app at them BEFORE
// boot, so Laravel's config reads the host-mapped ports (DB_HOST -> 127.0.0.1).
if (getenv('WP_DOCKER') === '1') {
    $orch = Orchestrator::forRoot($projectRoot);
    if ($orch !== null) {
        fwrite(STDERR, "[host] docker mode: bringing up dependencies\n");
        $up = $orch->up();
        foreach ($up['env'] as $k => $v) {
            putenv("{$k}={$v}");
            $_ENV[$k] = $v;
            $_SERVER[$k] = $v;
        }
        foreach ($up['warnings'] as $w) {
            fwrite(STDERR, "[host]   warn: {$w}\n");
        }
        fwrite(STDERR, "[host]   reached: " . implode(', ', array_map(
            static fn ($t) => "{$t['service']}@127.0.0.1:{$t['port']}",
            $up['targets']
        )) . "\n");
    } else {
        fwrite(STDERR, "[host] WP_DOCKER=1 but no compose file found\n");
    }
}

$module = \Waypoint\Runner\Module\ModuleFactory::for($projectRoot, $force);
$host = $module->host();
fwrite(STDERR, "[host] module=" . $module->id() . " driver=" . $host->describe()['driver'] . " root={$projectRoot}\n");

try {
    $host->boot();
    fwrite(STDERR, "[host] booted: " . $host->describe()['app'] . "\n");
} catch (\Throwable $e) {
    fwrite(STDERR, "[host] boot failed (continuing host-less for analysis): {$e->getMessage()}\n");
}

$debug = new \Waypoint\Runner\Debug\DebugManager();
$registry = new MethodRegistry($projectRoot, $module, $debug);
$dispatcher = new Dispatcher($registry->methods());

$server = new WebSocketServer($dispatcher, '127.0.0.1', $wsPort, $debug);

// Clean shutdown on Ctrl-C.
if (function_exists('pcntl_signal')) {
    pcntl_async_signals(true);
    pcntl_signal(SIGINT, function () use ($server) {
        fwrite(STDERR, "\n[host] shutting down\n");
        $server->stop();
    });
}

$server->serve();
