<?php

declare(strict_types=1);

namespace Waypoint\Probe\Buffer;

/**
 * The always-available fallback buffer: a JSON file holding the most-recent `max`
 * records within `ttl`. Read-modify-write under an exclusive lock so concurrent
 * workers don't clobber each other.
 */
final class FileBuffer implements Buffer
{
    public function __construct(
        private string $path,
        private int $max = 200,
        private int $ttl = 3600,
    ) {
    }

    public function push(array $record): void
    {
        $this->withLock(function (array $records) use ($record): array {
            $records[] = $record;
            return $this->trim($records);
        });
    }

    public function all(): array
    {
        return array_reverse($this->fresh($this->load()));
    }

    public function clear(): void
    {
        $this->write([]);
    }

    /** @param callable(list<array<string,mixed>>):list<array<string,mixed>> $fn */
    private function withLock(callable $fn): void
    {
        $dir = dirname($this->path);
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        $fh = @fopen($this->path, 'c+');
        if ($fh === false) {
            return;
        }
        try {
            flock($fh, LOCK_EX);
            rewind($fh);
            $raw = stream_get_contents($fh);
            $records = is_array($decoded = json_decode((string) $raw, true)) ? $decoded : [];
            $next = $fn($records);
            ftruncate($fh, 0);
            rewind($fh);
            fwrite($fh, json_encode($next, JSON_UNESCAPED_SLASHES));
            fflush($fh);
        } finally {
            flock($fh, LOCK_UN);
            fclose($fh);
        }
    }

    /** @return list<array<string,mixed>> */
    private function load(): array
    {
        $raw = @file_get_contents($this->path);
        $decoded = $raw === false ? [] : json_decode($raw, true);
        return is_array($decoded) ? $decoded : [];
    }

    private function write(array $records): void
    {
        $dir = dirname($this->path);
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        @file_put_contents($this->path, json_encode($records, JSON_UNESCAPED_SLASHES), LOCK_EX);
    }

    /** @param list<array<string,mixed>> $records @return list<array<string,mixed>> */
    private function trim(array $records): array
    {
        $records = $this->fresh($records);
        return array_slice($records, -$this->max);
    }

    /** Drop records older than ttl. @param list<array<string,mixed>> $records */
    private function fresh(array $records): array
    {
        if ($this->ttl <= 0) {
            return array_values($records);
        }
        $cutoff = time() - $this->ttl;
        return array_values(array_filter($records, static fn ($r) => ($r['at'] ?? 0) >= $cutoff));
    }
}
