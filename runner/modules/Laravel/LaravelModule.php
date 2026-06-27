<?php

declare(strict_types=1);

namespace Waypoint\Modules\Laravel;

use Waypoint\Runner\Host\HostInterface;
use Waypoint\Runner\Host\LaravelHost;
use Waypoint\Runner\Module\FrameworkModule;
use Waypoint\Runner\Module\OrmProvider;
use Waypoint\Runner\Module\RouteProvider;

/**
 * The Laravel framework module — the one object that wires Laravel into the
 * platform: the booted runtime (LaravelHost), route introspection
 * (LaravelRouteProvider), and the ORM (EloquentOrmProvider). Adding a framework
 * means writing one of these (+ a module.json).
 */
final class LaravelModule implements FrameworkModule
{
    private ?HostInterface $host = null;

    public function __construct(private string $root)
    {
    }

    public function id(): string
    {
        return 'laravel';
    }

    public function host(): HostInterface
    {
        return $this->host ??= new LaravelHost($this->root);
    }

    public function routes(): RouteProvider
    {
        return new LaravelRouteProvider($this->host());
    }

    public function orm(): ?OrmProvider
    {
        return new EloquentOrmProvider($this->root, $this->host());
    }
}
