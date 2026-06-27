<?php

declare(strict_types=1);

namespace Waypoint\Runner\Debug;

/**
 * Owns the interactive debug subprocess (bin/debug-run.php). The resident host's
 * WebSocket select loop polls readAvailable() so the loop stays responsive while
 * the subprocess is paused — that responsiveness is what lets the user send
 * continue/step while execution is suspended mid-stack.
 */
final class DebugManager
{
    /** @var resource|null */
    private $proc = null;
    /** @var array<int,resource> */
    private array $pipes = [];
    private string $buffer = '';

    /** @return array{ok:bool,error?:string} */
    public function start(string $runnerDir, array $config): array
    {
        $this->stop();
        $script = $runnerDir . '/bin/debug-run.php';
        $this->proc = proc_open(
            [PHP_BINARY, $script],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $this->pipes,
            $runnerDir
        );
        if (!is_resource($this->proc)) {
            return ['ok' => false, 'error' => 'failed to spawn debug subprocess'];
        }
        fwrite($this->pipes[0], json_encode($config) . "\n");
        stream_set_blocking($this->pipes[1], false);
        stream_set_blocking($this->pipes[2], false);
        return ['ok' => true];
    }

    public function active(): bool
    {
        return $this->proc !== null;
    }

    /** @return resource|null the stdout pipe, for stream_select */
    public function stdout()
    {
        return $this->pipes[1] ?? null;
    }

    /** Send a command (continue|step|stop) to the paused subprocess. */
    public function send(string $command): void
    {
        if (isset($this->pipes[0]) && is_resource($this->pipes[0])) {
            fwrite($this->pipes[0], $command . "\n");
        }
    }

    /**
     * Drain whatever the subprocess has emitted; closes the session on EOF.
     *
     * @return array<int,array<string,mixed>> parsed NDJSON messages
     */
    public function readAvailable(): array
    {
        if ($this->proc === null) {
            return [];
        }
        $out = $this->pipes[1];
        $chunk = fread($out, 65535);
        if ($chunk !== '' && $chunk !== false) {
            $this->buffer .= $chunk;
        }

        $messages = [];
        while (($nl = strpos($this->buffer, "\n")) !== false) {
            $line = substr($this->buffer, 0, $nl);
            $this->buffer = substr($this->buffer, $nl + 1);
            $msg = json_decode($line, true);
            if (is_array($msg)) {
                $messages[] = $msg;
            }
        }

        if (feof($out)) {
            $this->close();
        }
        return $messages;
    }

    public function stop(): void
    {
        if ($this->proc !== null) {
            @proc_terminate($this->proc);
            $this->close();
        }
    }

    private function close(): void
    {
        foreach ($this->pipes as $p) {
            if (is_resource($p)) {
                @fclose($p);
            }
        }
        if (is_resource($this->proc)) {
            @proc_close($this->proc);
        }
        $this->proc = null;
        $this->pipes = [];
        $this->buffer = '';
    }
}
