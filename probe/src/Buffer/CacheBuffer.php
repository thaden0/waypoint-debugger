<?php

declare(strict_types=1);

namespace Waypoint\Probe\Buffer;

use Illuminate\Contracts\Cache\Repository;

/**
 * Buffer backed by the app's cache store (Redis/DB/file per the app config) — so a
 * single pull retrieves records across all workers/containers, unlike per-process
 * memory. Read-modify-write (not atomic; a buffer can tolerate rare loss).
 */
final class CacheBuffer implements Buffer
{
    private const KEY = 'waypoint:probe:buffer';

    public function __construct(
        private Repository $cache,
        private int $max = 200,
        private int $ttl = 3600,
    ) {
    }

    public function push(array $record): void
    {
        $records = $this->fresh((array) $this->cache->get(self::KEY, []));
        $records[] = $record;
        $this->cache->put(self::KEY, array_slice($records, -$this->max), $this->ttl);
    }

    public function all(): array
    {
        return array_reverse($this->fresh((array) $this->cache->get(self::KEY, [])));
    }

    public function clear(): void
    {
        $this->cache->forget(self::KEY);
    }

    /** @param array<int,mixed> $records @return list<array<string,mixed>> */
    private function fresh(array $records): array
    {
        if ($this->ttl <= 0) {
            return array_values($records);
        }
        $cutoff = time() - $this->ttl;
        return array_values(array_filter($records, static fn ($r) => is_array($r) && ($r['at'] ?? 0) >= $cutoff));
    }
}
