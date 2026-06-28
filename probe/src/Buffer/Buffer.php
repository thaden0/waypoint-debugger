<?php

declare(strict_types=1);

namespace Waypoint\Probe\Buffer;

/**
 * A bounded ring buffer of probe records — the prod-safety guarantee: it never
 * grows past `max`, evicting oldest, so appending is cheap and storage is capped.
 */
interface Buffer
{
    /** @param array<string,mixed> $record */
    public function push(array $record): void;

    /** @return list<array<string,mixed>> most-recent first */
    public function all(): array;

    public function clear(): void;
}
