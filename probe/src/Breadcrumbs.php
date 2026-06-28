<?php

declare(strict_types=1);

namespace Waypoint\Probe;

/**
 * A request-scoped, bounded trail of what happened leading up to an error — DB
 * queries, log events — accumulated cheaply in memory and attached to the error
 * record only when a trigger fires. The "state before the error" without
 * instrumenting the live app; nothing is persisted unless an error is reported,
 * so a clean request costs (almost) nothing.
 */
final class Breadcrumbs
{
    /** @var list<array{type:string,at:float,data:array<string,mixed>}> */
    private array $crumbs = [];

    public function __construct(private int $max = 50)
    {
    }

    /** @param array<string,mixed> $data */
    public function add(string $type, array $data): void
    {
        $this->crumbs[] = ['type' => $type, 'at' => microtime(true), 'data' => $data];
        if (count($this->crumbs) > $this->max) {
            array_shift($this->crumbs);
        }
    }

    /** @return list<array{type:string,at:float,data:array<string,mixed>}> */
    public function all(): array
    {
        return $this->crumbs;
    }
}
