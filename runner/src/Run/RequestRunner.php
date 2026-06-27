<?php

declare(strict_types=1);

namespace Waypoint\Runner\Run;

/**
 * Parent side of the whole-request run. Spawns bin/request-run.php as a fresh
 * subprocess (correct instrumentation every time), feeds it the run-config, and
 * reads its NDJSON stdout: each capture line is handed to $onCapture as it
 * arrives (so the UI ledger fills live), and the final run.result line is
 * returned. Process isolation means a crash or fatal in the run can't take the
 * resident host down with it.
 */
final class RequestRunner
{
    public function __construct(private string $runnerDir)
    {
    }

    /**
     * @param array<string,mixed> $config       run-config for bin/request-run.php
     * @param null|callable(string,array):void $onEvent  called per streamed notification (method, params)
     * @return array{ok:bool,result?:mixed,response?:mixed,error?:string,ledger?:array}
     */
    public function run(array $config, ?callable $onEvent = null): array
    {
        $script = $this->runnerDir . '/bin/request-run.php';
        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];

        $proc = proc_open([PHP_BINARY, $script], $descriptors, $pipes, $this->runnerDir);
        if (!is_resource($proc)) {
            return ['ok' => false, 'error' => 'failed to spawn request-run subprocess'];
        }

        fwrite($pipes[0], json_encode($config));
        fclose($pipes[0]);

        stream_set_blocking($pipes[1], true);

        $final = null;
        $buffer = '';
        while (!feof($pipes[1])) {
            $chunk = fread($pipes[1], 8192);
            if ($chunk === false || $chunk === '') {
                continue;
            }
            $buffer .= $chunk;
            // Process complete NDJSON lines as they arrive.
            while (($nl = strpos($buffer, "\n")) !== false) {
                $line = substr($buffer, 0, $nl);
                $buffer = substr($buffer, $nl + 1);
                $msg = json_decode($line, true);
                if (!is_array($msg)) {
                    continue;
                }
                $method = $msg['method'] ?? '';
                if ($method === 'run.result') {
                    $final = $msg['params'] ?? null;
                } elseif ($method !== '' && $onEvent !== null) {
                    // forward ledger.captured, breakpoint.hit, … live to the UI
                    $onEvent($method, $msg['params'] ?? []);
                }
            }
        }

        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($proc);

        if ($final === null) {
            return ['ok' => false, 'error' => 'subprocess produced no result' . ($stderr ? ': ' . trim($stderr) : '')];
        }
        if ($stderr !== '' && ($final['ok'] ?? false) === false && empty($final['error'])) {
            $final['error'] = trim($stderr);
        }
        return $final;
    }
}
