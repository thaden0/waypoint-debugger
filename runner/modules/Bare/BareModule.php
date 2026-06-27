<?php

declare(strict_types=1);

namespace Waypoint\Modules\Bare;

use Waypoint\Runner\Host\BareHost;
use Waypoint\Runner\Host\HostInterface;
use Waypoint\Runner\Module\FrameworkModule;
use Waypoint\Runner\Module\NullRouteProvider;
use Waypoint\Runner\Module\OrmProvider;
use Waypoint\Runner\Module\RouteProvider;

/**
 * The frameworkless fallback module — exercises the full pipeline against plain
 * PHP. No router, no ORM; just the BareHost runtime.
 */
final class BareModule implements FrameworkModule
{
    private ?HostInterface $host = null;

    public function __construct(private string $root)
    {
    }

    public function id(): string
    {
        return 'bare';
    }

    public function host(): HostInterface
    {
        return $this->host ??= new BareHost($this->root);
    }

    public function routes(): RouteProvider
    {
        return new NullRouteProvider();
    }

    public function orm(): ?OrmProvider
    {
        return null;
    }
}
