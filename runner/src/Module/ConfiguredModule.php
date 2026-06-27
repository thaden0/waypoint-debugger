<?php

declare(strict_types=1);

namespace Waypoint\Runner\Module;

use Waypoint\Runner\Host\HostInterface;

/**
 * A base framework module with per-project provider overrides applied (from
 * `.waypoint/config.json`). The framework supplies defaults (Laravel → Eloquent);
 * a project may swap an individual provider by id — e.g. an ORM provider —
 * because every consumer talks only to the interface. Provider impls share the
 * convention `__construct(string $root, HostInterface $host)`.
 */
final class ConfiguredModule implements FrameworkModule
{
    /** @param array{orm:?string,routes:?string} $overrides */
    public function __construct(
        private FrameworkModule $base,
        private ModuleRegistry $registry,
        private string $root,
        private array $overrides,
    ) {
    }

    public function id(): string
    {
        return $this->base->id();
    }

    public function host(): HostInterface
    {
        return $this->base->host();
    }

    public function routes(): RouteProvider
    {
        $class = $this->overrideClass('routes');
        if ($class !== null) {
            /** @var RouteProvider */
            return new $class($this->root, $this->base->host());
        }
        return $this->base->routes();
    }

    public function orm(): ?OrmProvider
    {
        $class = $this->overrideClass('orm');
        if ($class !== null) {
            /** @var OrmProvider */
            return new $class($this->root, $this->base->host());
        }
        return $this->base->orm();
    }

    private function overrideClass(string $capability): ?string
    {
        $id = $this->overrides[$capability] ?? null;
        return $id !== null && $id !== '' ? $this->registry->providerClass($capability, $id) : null;
    }
}
