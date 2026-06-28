<?php

declare(strict_types=1);

// Standalone tests for the probe's framework-free core (bounded buffer + redaction).
// Run with plain PHP — no phpunit needed: `php probe/run-tests.php`.

require __DIR__ . '/src/Buffer/Buffer.php';
require __DIR__ . '/src/Buffer/FileBuffer.php';
require __DIR__ . '/src/Recorder.php';

use Waypoint\Probe\Buffer\FileBuffer;
use Waypoint\Probe\Recorder;

$ok = true;
$assert = function (bool $cond, string $msg) use (&$ok): void {
    echo ($cond ? "  ok   " : "  FAIL ") . $msg . "\n";
    $ok = $ok && $cond;
};

// --- bounded ring buffer ---
$file = sys_get_temp_dir() . '/probe-test-' . uniqid() . '.json';
$buf = new FileBuffer($file, 3, 3600);
for ($i = 1; $i <= 5; $i++) {
    $buf->push(['id' => "r$i", 'at' => time()]);
}
$all = $buf->all();
$assert(count($all) === 3, 'buffer capped at max=3');
$assert($all[0]['id'] === 'r5' && $all[2]['id'] === 'r3', 'most-recent-first, oldest evicted');
$buf->clear();
$assert($buf->all() === [], 'clear empties the buffer');
@unlink($file);

$ttlFile = sys_get_temp_dir() . '/probe-ttl-' . uniqid() . '.json';
$buf2 = new FileBuffer($ttlFile, 10, 1);
$buf2->push(['id' => 'old', 'at' => time() - 100]);
$buf2->push(['id' => 'new', 'at' => time()]);
$assert(count($buf2->all()) === 1 && $buf2->all()[0]['id'] === 'new', 'ttl evicts stale records');
@unlink($ttlFile);

// --- redaction ---
$rec = new Recorder(['password', 'token', 'authorization', 'secret']);
$record = $rec->exceptionRecord(new RuntimeException('boom'), [
    'method' => 'POST',
    'uri' => '/login',
    'input' => ['email' => 'a@b.com', 'password' => 'hunter2', 'nested' => ['api_token' => 'xyz', 'keep' => 1]],
    'headers' => ['authorization' => 'Bearer abc', 'accept' => 'application/json'],
]);
$assert($record['request']['input']['password'] === '[redacted]', 'password redacted');
$assert($record['request']['input']['nested']['api_token'] === '[redacted]', 'nested *token* redacted');
$assert($record['request']['input']['nested']['keep'] === 1, 'non-sensitive kept');
$assert($record['request']['headers']['authorization'] === '[redacted]', 'auth header redacted');
$assert($record['kind'] === 'exception' && $record['class'] === 'RuntimeException', 'exception record shape');

$log = $rec->logRecord('error', 'failed', ['secret' => 's', 'x' => 2]);
$assert($log['kind'] === 'log' && $log['context']['secret'] === '[redacted]' && $log['context']['x'] === 2, 'log record + context redaction');

echo $ok ? "\nPASS\n" : "\nFAIL\n";
exit($ok ? 0 : 1);
