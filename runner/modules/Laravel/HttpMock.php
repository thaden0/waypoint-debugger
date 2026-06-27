<?php

declare(strict_types=1);

namespace Waypoint\Modules\Laravel;

/**
 * Boundary-level outbound mock — distinct from swaps (which mock a code line).
 * Drives Laravel's own `Http::fake()` so any outbound call matching a URL pattern
 * returns a canned response, no matter where in the code (or vendor SDK) it
 * happens. The §5.5 principle: reuse the framework's faking, don't build an
 * interceptor. Applied before an instrumented run so the slice is deterministic.
 */
final class HttpMock
{
    /** @param list<array{pattern?:string,status?:int,body?:string,json?:mixed,headers?:array<string,string>}> $mocks */
    public static function apply(array $mocks): void
    {
        $http = 'Illuminate\\Support\\Facades\\Http';
        if ($mocks === [] || !class_exists($http)) {
            return;
        }
        $map = [];
        foreach ($mocks as $m) {
            $pattern = $m['pattern'] ?? '*';
            $body = array_key_exists('json', $m) ? $m['json'] : ($m['body'] ?? '');
            $map[$pattern] = $http::response($body, (int) ($m['status'] ?? 200), $m['headers'] ?? []);
        }
        try {
            $http::fake($map);
        } catch (\Throwable) {
            // Http facade not bootable in this context — skip silently.
        }
    }
}
