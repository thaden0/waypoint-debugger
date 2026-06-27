<?php

declare(strict_types=1);

namespace Waypoint\Runner\Module;

/** No router (frameworkless / a language with no framework module loaded). */
final class NullRouteProvider implements RouteProvider
{
    public function routes(): array
    {
        return [];
    }
}
