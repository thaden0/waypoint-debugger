<?php

declare(strict_types=1);

/**
 * Interactive debug subprocess. Unlike a one-shot run, this BLOCKS at each
 * breakpoint/step so the user can continue or step — the call stack stays live
 * and resumes in place (true pause/resume, which an in-process run can't do
 * without freezing the host).
 *
 * Protocol over stdin/stdout (NDJSON):
 *   stdin  line 1     : run-config JSON
 *   stdin  later lines: commands — "continue" | "step" | "stop"
 *   stdout            : {method:'debug.paused', params:{id,line,scope}} at each
 *                       pause, then {method:'debug.finished', params:{...}}.
 */

require __DIR__ . '/../vendor/autoload.php';

use Waypoint\Runner\Debug\Breakpoint;
use Waypoint\Runner\Host\HostFactory;
use Waypoint\Runner\Run\SliceRunner;

$config = json_decode((string) fgets(STDIN), true);
if (!is_array($config)) {
    fwrite(STDOUT, json_encode(['jsonrpc' => '2.0', 'method' => 'debug.finished', 'params' => ['ok' => false, 'error' => 'bad config']]) . "\n");
    exit(1);
}

$emit = static function (array $message): void {
    fwrite(STDOUT, json_encode($message) . "\n");
    fflush(STDOUT);
};

// Optional simple PSR-4 autoloader for frameworkless fixtures/projects.
foreach ($config['psr4'] ?? [] as $prefix => $dir) {
    $prefix = rtrim($prefix, '\\') . '\\';
    $dir = rtrim($dir, '/') . '/';
    spl_autoload_register(static function (string $class) use ($prefix, $dir): void {
        if (str_starts_with($class, $prefix) && is_file($f = $dir . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php')) {
            require $f;
        }
    });
}

$host = HostFactory::for($config['projectRoot'] ?? getcwd(), $config['driver'] ?? null);
try {
    $host->boot();
} catch (\Throwable) {
    // bare host / non-Laravel: nothing to boot
}

// Pause = emit the state, then block reading the next command from stdin.
Breakpoint::setPauseHandler(function (string $id, int $line, array $scope) use ($emit): string {
    $emit(['jsonrpc' => '2.0', 'method' => 'debug.paused', 'params' => ['id' => $id, 'line' => $line, 'scope' => $scope]]);
    $cmd = trim((string) fgets(STDIN));
    return $cmd !== '' ? $cmd : 'continue';
});

$result = (new SliceRunner($host))->run([
    'source' => $config['source'],
    'class' => $config['class'],
    'method' => $config['method'],
    'args' => $config['args'] ?? [],
    'receiverArgs' => $config['receiverArgs'] ?? [],
    'swaps' => $config['swaps'] ?? [],
    'breakpoints' => $config['breakpoints'] ?? [],
    'breakpointMode' => 'interactive',
    'step' => true, // step probes injected so the user can step line-by-line
]);

$emit(['jsonrpc' => '2.0', 'method' => 'debug.finished', 'params' => [
    'ok' => $result['ok'] ?? false,
    'stopped' => $result['stopped'] ?? false,
    'result' => $result['result'] ?? null,
    'error' => $result['error'] ?? null,
]]);
