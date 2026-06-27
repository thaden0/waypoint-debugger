<?php

declare(strict_types=1);

/**
 * Single-request runner, executed as a FRESH subprocess by RequestRunner so the
 * include-time instrumentation is always correct (PHP can't redefine a loaded
 * class, so a resident process can't re-instrument between runs).
 *
 * Reads a JSON run-config on stdin, registers the InstrumentingStreamWrapper for
 * the targeted files, boots the host, drives the entry, and streams NDJSON to
 * stdout: one line per capture (as it fires) and a final run.result line. The
 * parent reads these and fans the captures out over the WebSocket.
 *
 * Config shape:
 * {
 *   "projectRoot": "...", "driver": "bare|laravel",
 *   "psr4": {"App\\": "/abs/app/"},                 // optional (fixtures)
 *   "targets": {"app/Foo.php": {"waypoints":[...], "swaps":[...]}},
 *   "entry": {"kind":"call","class":"App\\Foo","method":"bar","args":[...]} |
 *            {"kind":"http","method":"GET","uri":"/","params":{}}
 * }
 */

require __DIR__ . '/../vendor/autoload.php';

use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Debug\Breakpoint;
use Waypoint\Runner\Debug\BreakpointHalt;
use Waypoint\Runner\Host\HostFactory;
use Waypoint\Runner\Instrument\InstrumentingStreamWrapper;
use Waypoint\Runner\Rpc\Notifier;

$config = json_decode((string) stream_get_contents(STDIN), true);
if (!is_array($config)) {
    fwrite(STDOUT, json_encode(['jsonrpc' => '2.0', 'method' => 'run.result', 'params' => ['ok' => false, 'error' => 'bad config']]) . "\n");
    exit(1);
}

$emit = static function (array $message): void {
    fwrite(STDOUT, json_encode($message) . "\n");
    fflush(STDOUT);
};

// Stream every capture to the parent the instant a waypoint fires.
Notifier::setSink($emit);

// Optional simple PSR-4 autoloader for frameworkless fixtures/projects.
foreach ($config['psr4'] ?? [] as $prefix => $dir) {
    $prefix = rtrim($prefix, '\\') . '\\';
    $dir = rtrim($dir, '/') . '/';
    spl_autoload_register(static function (string $class) use ($prefix, $dir): void {
        if (!str_starts_with($class, $prefix)) {
            return;
        }
        $rel = str_replace('\\', '/', substr($class, strlen($prefix)));
        $file = $dir . $rel . '.php';
        if (is_file($file)) {
            require $file; // routed through the wrapper -> instrumented if targeted
        }
    });
}

$host = HostFactory::for($config['projectRoot'] ?? getcwd(), $config['driver'] ?? null);

// Route introspection: a one-shot fresh boot so the listing reflects the route
// files on disk right now, not the resident host's boot-time snapshot. No
// instrumentation needed, so short-circuit before the wrapper/recorder setup.
if ((($config['entry']['kind'] ?? '') === 'routes')) {
    try {
        $host->boot();
        $emit(['jsonrpc' => '2.0', 'method' => 'run.result', 'params' => ['ok' => true, 'routes' => $host->routes()]]);
        exit(0);
    } catch (\Throwable $e) {
        $emit(['jsonrpc' => '2.0', 'method' => 'run.result', 'params' => ['ok' => false, 'error' => $e->getMessage(), 'routes' => []]]);
        exit(1);
    }
}

// Register BEFORE boot/entry so targeted classes are instrumented on first load.
InstrumentingStreamWrapper::activate($config['projectRoot'] ?? getcwd(), $config['targets'] ?? []);

Recorder::reset();
Breakpoint::reset();
// In a whole Laravel request, halting via exception would be swallowed by the
// framework's error handler, so breakpoints stream every hit (trace) rather than
// halt. (run.slice, a direct invoke, uses halt.)
Breakpoint::setMode($config['breakpointMode'] ?? 'trace');

try {
    $host->boot();
    $entry = $config['entry'] ?? ['kind' => 'http', 'method' => 'GET', 'uri' => '/'];

    if (($entry['kind'] ?? 'http') === 'call') {
        $result = runCall($host, $entry);
    } else {
        $response = $host->renderEntry(
            $entry['method'] ?? 'GET',
            $entry['uri'] ?? '/',
            $entry['params'] ?? [],
            $entry['options'] ?? []
        );
        $result = ['ok' => true, 'response' => $response];
    }

    $emit(['jsonrpc' => '2.0', 'method' => 'run.result', 'params' => [
        'ok' => $result['ok'],
        'paused' => $result['paused'] ?? false,
        'breakpoint' => $result['breakpoint'] ?? null,
        'result' => $result['result'] ?? null,
        'response' => $result['response'] ?? null,
        'error' => $result['error'] ?? null,
        // Full ledger (with base64 blobs) so the resident host can replay a
        // captured waypoint after this subprocess exits.
        'ledger' => Recorder::ledgerFull(),
        'breakpoints' => Breakpoint::hits(),
    ]]);
} catch (\Throwable $e) {
    InstrumentingStreamWrapper::deactivate();
    $emit(['jsonrpc' => '2.0', 'method' => 'run.result', 'params' => [
        'ok' => false,
        'error' => $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine(),
        'ledger' => Recorder::ledger(),
    ]]);
    exit(1);
}

InstrumentingStreamWrapper::deactivate();

/**
 * Drive a direct method call entry (non-HTTP). The class loads through the
 * wrapper and so is instrumented; the receiver is built from the host container
 * when possible, else constructed directly.
 */
function runCall(object $host, array $entry): array
{
    $class = $entry['class'];
    $method = $entry['method'];
    $args = $entry['args'] ?? [];

    if (!class_exists($class)) {
        return ['ok' => false, 'error' => "class {$class} not found"];
    }

    $receiver = $host->make($class);
    if ($receiver === null) {
        try {
            $receiver = (new \ReflectionClass($class))->newInstanceArgs($entry['receiverArgs'] ?? []);
        } catch (\Throwable $e) {
            return ['ok' => false, 'error' => 'cannot construct receiver: ' . $e->getMessage()];
        }
    }

    [$begin, , $rollback] = $host->transactionHooks();
    $begin();
    try {
        $result = $receiver->$method(...$args);
        $rollback(); // real runs record but don't keep writes by default
        return ['ok' => true, 'result' => summarizeResult($result)];
    } catch (BreakpointHalt $halt) {
        $rollback();
        return ['ok' => true, 'paused' => true, 'breakpoint' => ['id' => $halt->bpId, 'scope' => $halt->scope]];
    } catch (\Throwable $e) {
        $rollback();
        return ['ok' => false, 'error' => $e->getMessage()];
    }
}

function summarizeResult(mixed $result): mixed
{
    if ($result === null || is_scalar($result) || is_array($result)) {
        return $result;
    }
    return ['__type' => get_debug_type($result)];
}
