<?php

declare(strict_types=1);

/**
 * FrankenPHP worker-mode entrypoint. Same runner-as-host logic as bin/host.php,
 * but the app is kept resident by FrankenPHP across HTTP requests rather than by
 * a CLI select loop. Run with:
 *
 *   PROJECT_ROOT=/path/to/laravel \
 *   frankenphp run --config Caddyfile        # Caddyfile points worker -> this file
 *
 * The control plane (JSON-RPC) is served per request here; live streaming uses
 * the standalone WebSocket from bin/host.php (Caddy proxies the WS upgrade). This
 * file degrades to a no-op note when run outside FrankenPHP so the repo stays
 * runnable on a stock PHP install.
 */

require __DIR__ . '/../vendor/autoload.php';

use Waypoint\Runner\Host\HostFactory;
use Waypoint\Runner\Rpc\Dispatcher;
use Waypoint\Runner\Rpc\MethodRegistry;

if (!function_exists('frankenphp_handle_request')) {
    fwrite(STDERR, "[worker] frankenphp not detected — use bin/host.php for the CLI resident host.\n");
    exit(1);
}

$projectRoot = getenv('PROJECT_ROOT') ?: getcwd();

// Boot once, outside the request loop — the worker-mode win.
$module = \Waypoint\Runner\Module\ModuleFactory::for($projectRoot, getenv('WP_HOST_DRIVER') ?: null);
$module->host()->boot();
$registry = new MethodRegistry($projectRoot, $module);
$dispatcher = new Dispatcher($registry->methods());

$keepRunning = true;
while ($keepRunning) {
    $keepRunning = \frankenphp_handle_request(function () use ($dispatcher, $host): void {
        header('Content-Type: application/json');
        header('Access-Control-Allow-Origin: *');

        $body = file_get_contents('php://input') ?: '';
        $request = json_decode($body, true);
        if (!is_array($request)) {
            echo json_encode(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32700, 'message' => 'parse error']]);
            return;
        }
        $response = $dispatcher->handle($request);
        echo json_encode($response);

        // Octane/FrankenPHP reset between requests — the ledger-boundary reset.
        $host->resetState();
    });
}
