<?php

declare(strict_types=1);

namespace Waypoint\Runner\Rpc;

/**
 * Transport-neutral JSON-RPC 2.0 dispatcher. Today it is driven by the HTTP
 * server (bin/server.php); the live-run phase drives the same dispatcher over a
 * WebSocket so streamed pause/scope/resume events ride one wire. Keeping dispatch
 * separate from transport is what lets that swap be additive.
 */
final class Dispatcher
{
    /** @param array<string,callable> $methods */
    public function __construct(private array $methods)
    {
    }

    /** Handle a single request object, returning the response object (or null for a notification). */
    public function handle(array $request): ?array
    {
        $id = $request['id'] ?? null;
        $method = $request['method'] ?? null;
        $params = $request['params'] ?? [];

        if (!is_string($method) || !isset($this->methods[$method])) {
            return $this->error($id, -32601, "method not found: " . (is_string($method) ? $method : '(none)'));
        }

        try {
            $result = ($this->methods[$method])($params);
        } catch (RpcException $e) {
            return $this->error($id, $e->rpcCode, $e->getMessage());
        } catch (\Throwable $e) {
            return $this->error($id, -32603, $e->getMessage(), [
                'class' => $e::class,
                'file' => $e->getFile() . ':' . $e->getLine(),
            ]);
        }

        if ($id === null) {
            return null; // notification
        }
        return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];
    }

    private function error(mixed $id, int $code, string $message, mixed $data = null): array
    {
        $err = ['code' => $code, 'message' => $message];
        if ($data !== null) {
            $err['data'] = $data;
        }
        return ['jsonrpc' => '2.0', 'id' => $id, 'error' => $err];
    }
}
