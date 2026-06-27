<?php

declare(strict_types=1);

namespace Waypoint\Runner\Rpc;

/**
 * A single-threaded, select-based WebSocket server for the control plane. It
 * reuses the same Dispatcher as the HTTP transport — request/response JSON-RPC
 * rides the socket, and the Notifier pushes server-initiated events (waypoint
 * captures, run progress) to connected clients. One process, one wire.
 *
 * No event-loop dependency: stream_select over the listen socket + client
 * sockets is enough for a localhost dev tool. The booted application lives in
 * this same process (runner-as-host), so capture hooks reach the ledger directly.
 */
final class WebSocketServer
{
    /** @var array<int,resource> */
    private array $clients = [];
    /** @var array<int,bool> */
    private array $handshaken = [];
    /** @var array<int,string> */
    private array $buffers = [];
    private bool $running = false;

    public function __construct(
        private Dispatcher $dispatcher,
        private string $host = '127.0.0.1',
        private int $port = 9778,
        private ?\Waypoint\Runner\Debug\DebugManager $debug = null,
    ) {
    }

    public function serve(): void
    {
        $listen = stream_socket_server("tcp://{$this->host}:{$this->port}", $errno, $errstr);
        if ($listen === false) {
            throw new \RuntimeException("cannot bind ws://{$this->host}:{$this->port}: {$errstr} ({$errno})");
        }
        stream_set_blocking($listen, false);
        $this->running = true;

        // Any notification produced anywhere in this process fans out to clients.
        Notifier::setSink(function (array $message): void {
            $this->broadcast($message);
        });

        fwrite(STDERR, "[ws] listening on ws://{$this->host}:{$this->port}\n");

        while ($this->running) {
            $read = [$listen, ...array_values($this->clients)];
            // Multiplex the interactive debug subprocess onto the same loop, so
            // its pauses stream out while the loop stays free to receive commands.
            $debugOut = $this->debug?->active() ? $this->debug->stdout() : null;
            if ($debugOut !== null) {
                $read[] = $debugOut;
            }
            $write = null;
            $except = null;
            // Wake periodically so notifications queued between reads still flush.
            if (@stream_select($read, $write, $except, 0, 200000) === false) {
                continue;
            }

            foreach ($read as $sock) {
                if ($sock === $listen) {
                    $this->accept($listen);
                } elseif ($debugOut !== null && $sock === $debugOut) {
                    foreach ($this->debug->readAvailable() as $msg) {
                        Notifier::notify($msg['method'] ?? 'debug.event', $msg['params'] ?? []);
                    }
                } else {
                    $this->onReadable($sock);
                }
            }
        }
    }

    public function stop(): void
    {
        $this->running = false;
    }

    private function accept($listen): void
    {
        $client = @stream_socket_accept($listen, 0);
        if ($client === false) {
            return;
        }
        stream_set_blocking($client, false);
        $id = (int) $client;
        $this->clients[$id] = $client;
        $this->handshaken[$id] = false;
        $this->buffers[$id] = '';
    }

    private function onReadable($sock): void
    {
        $id = (int) $sock;
        $chunk = @fread($sock, 65535);
        if ($chunk === '' || $chunk === false) {
            if (feof($sock)) {
                $this->disconnect($id);
            }
            return;
        }
        $this->buffers[$id] .= $chunk;

        if (!$this->handshaken[$id]) {
            $this->tryHandshake($id);
            return;
        }
        $this->drainFrames($id);
    }

    private function tryHandshake(int $id): void
    {
        $buffer = $this->buffers[$id];
        if (!str_contains($buffer, "\r\n\r\n")) {
            return; // headers incomplete
        }
        if (!preg_match('/Sec-WebSocket-Key:\s*(.+)\r\n/i', $buffer, $m)) {
            $this->disconnect($id);
            return;
        }
        $accept = WebSocketFrame::acceptKey(trim($m[1]));
        $response = "HTTP/1.1 101 Switching Protocols\r\n"
            . "Upgrade: websocket\r\n"
            . "Connection: Upgrade\r\n"
            . "Sec-WebSocket-Accept: {$accept}\r\n\r\n";
        @fwrite($this->clients[$id], $response);
        $this->handshaken[$id] = true;
        $this->buffers[$id] = '';
    }

    private function drainFrames(int $id): void
    {
        while (true) {
            $frame = WebSocketFrame::decode($this->buffers[$id]);
            if ($frame === null) {
                return;
            }
            $this->buffers[$id] = substr($this->buffers[$id], $frame['consumed']);

            switch ($frame['opcode']) {
                case WebSocketFrame::OP_CLOSE:
                    $this->disconnect($id);
                    return;
                case WebSocketFrame::OP_PING:
                    @fwrite($this->clients[$id], WebSocketFrame::encode(WebSocketFrame::OP_PONG, $frame['payload']));
                    break;
                case WebSocketFrame::OP_TEXT:
                    $this->onMessage($id, $frame['payload']);
                    break;
                default:
                    // ignore pong/binary/continuation for the control plane
                    break;
            }
        }
    }

    private function onMessage(int $id, string $text): void
    {
        $request = json_decode($text, true);
        if (!is_array($request)) {
            return;
        }
        $response = $this->dispatcher->handle($request);
        if ($response !== null) {
            $this->send($id, $response);
        }
    }

    private function send(int $id, array $message): void
    {
        if (isset($this->clients[$id])) {
            @fwrite($this->clients[$id], WebSocketFrame::encodeText(json_encode($message)));
        }
    }

    private function broadcast(array $message): void
    {
        $encoded = WebSocketFrame::encodeText(json_encode($message));
        foreach ($this->clients as $id => $sock) {
            if (($this->handshaken[$id] ?? false)) {
                @fwrite($sock, $encoded);
            }
        }
    }

    private function disconnect(int $id): void
    {
        if (isset($this->clients[$id])) {
            @fclose($this->clients[$id]);
        }
        unset($this->clients[$id], $this->handshaken[$id], $this->buffers[$id]);
    }
}
