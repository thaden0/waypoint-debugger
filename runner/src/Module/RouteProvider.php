<?php

declare(strict_types=1);

namespace Waypoint\Runner\Module;

/**
 * The API-console surface a framework module supplies — introspect the app's HTTP
 * routes from the booted application into the auto-collection. Swappable per
 * framework (Laravel router, ASP.NET routing, Express table).
 */
interface RouteProvider
{
    /** @return list<array{methods:array<int,string>,uri:string,name:?string,action:string,middleware:array<int,string>,params:array<int,string>}> */
    public function routes(): array;
}
