<?php

declare(strict_types=1);

/**
 * HTTP JSON-RPC server for the Waypoint runner.
 *
 *   PROJECT_ROOT=/path/to/laravel php -S 127.0.0.1:9777 bin/server.php
 *
 * Single endpoint: POST / with a JSON-RPC 2.0 request (single or batch).
 * GET / returns runner.info for a quick health check. CORS is wide-open for
 * localhost dev (the UI is served from the Vite dev server on another port).
 *
 * The WebSocket transport for live runs reuses the same Dispatcher; this HTTP
 * front is the request/response surface used for static analysis and swaps.
 */

require __DIR__ . '/../vendor/autoload.php';

use Waypoint\Runner\Rpc\Dispatcher;
use Waypoint\Runner\Rpc\MethodRegistry;

$projectRoot = getenv('PROJECT_ROOT') ?: getcwd();

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Content-Type: application/json');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'OPTIONS') {
    http_response_code(204);
    return;
}

$registry = new MethodRegistry($projectRoot);
$dispatcher = new Dispatcher($registry->methods());

if ($method === 'GET') {
    echo json_encode(['jsonrpc' => '2.0', 'id' => 0, 'result' => ($registry->methods()['runner.info'])()]);
    return;
}

$body = file_get_contents('php://input') ?: '';
$payload = json_decode($body, true);

if (!is_array($payload)) {
    echo json_encode(['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32700, 'message' => 'parse error']]);
    return;
}

// Batch (list of requests) vs single.
$isBatch = array_is_list($payload) && isset($payload[0]);
$requests = $isBatch ? $payload : [$payload];

$responses = [];
foreach ($requests as $req) {
    $res = $dispatcher->handle(is_array($req) ? $req : []);
    if ($res !== null) {
        $responses[] = $res;
    }
}

echo json_encode($isBatch ? $responses : ($responses[0] ?? null));
