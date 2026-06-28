<?php

declare(strict_types=1);

namespace Waypoint\Probe;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Waypoint\Probe\Buffer\Buffer;

/**
 * The authenticated, bidirectional endpoint the Waypoint tool reaches:
 *   GET  → pull buffered records (and ack/clear), plus the active config
 *   POST → push config (ring-buffer toggle, trigger classes)
 * Auth is a timing-safe shared-secret compare + optional IP allowlist. Fails
 * closed: no secret configured ⇒ 404-equivalent 401.
 */
final class ProbeController
{
    public function __construct(private Buffer $buffer)
    {
    }

    public function pull(Request $request): JsonResponse
    {
        if (!$this->authorized($request)) {
            return response()->json(['error' => 'unauthorized'], 401);
        }
        $records = $this->buffer->all();
        if ($request->boolean('ack', true)) {
            $this->buffer->clear();
        }
        return response()->json([
            'records' => $records,
            'config' => $this->activeConfig(),
            'app' => config('app.name'),
            'env' => app()->environment(),
        ]);
    }

    public function config(Request $request): JsonResponse
    {
        if (!$this->authorized($request)) {
            return response()->json(['error' => 'unauthorized'], 401);
        }
        $config = [
            'ring_buffer' => $request->boolean('ring_buffer'),
            'triggers' => array_values(array_filter((array) $request->input('triggers', []))),
        ];
        if (function_exists('cache')) {
            cache()->put(ProbeConfig::CONFIG_KEY, $config, 86400);
        }
        return response()->json(['ok' => true, 'config' => $config]);
    }

    /** @return array{ring_buffer:bool,triggers:list<string>} */
    private function activeConfig(): array
    {
        return ProbeConfig::active();
    }

    private function authorized(Request $request): bool
    {
        $secret = (string) config('waypoint-probe.secret');
        $given = $request->header('X-Waypoint-Secret') ?? (string) $request->bearerToken();
        if ($secret === '' || $given === '' || !hash_equals($secret, (string) $given)) {
            return false;
        }
        $allow = (array) config('waypoint-probe.allow_ips', []);
        if ($allow !== [] && !in_array($request->ip(), $allow, true)) {
            return false;
        }
        return true;
    }
}
