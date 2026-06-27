<?php

declare(strict_types=1);

namespace Waypoint\Modules\Laravel;

use Waypoint\Runner\Host\HostInterface;
use Waypoint\Runner\Module\RouteProvider;

/**
 * Introspect Laravel's router from the booted app into the api-console schema —
 * methods + URI + name + action + middleware + params. Reads the live route
 * collection via the container, so it reflects whatever route files booted.
 */
final class LaravelRouteProvider implements RouteProvider
{
    // Provider convention: (root, host). The root is unused here but keeps the
    // signature uniform so the registry can instantiate any provider the same way.
    public function __construct(private string $root, private HostInterface $host)
    {
    }

    public function routes(): array
    {
        $this->host->boot();
        $router = $this->host->make('router');
        if ($router === null) {
            return [];
        }

        $out = [];
        foreach ($router->getRoutes() as $route) {
            $methods = array_values(array_filter(
                $route->methods(),
                static fn (string $m): bool => $m !== 'HEAD'
            ));
            $action = $route->getActionName();
            $out[] = [
                'methods' => $methods,
                'uri' => '/' . ltrim($route->uri(), '/'),
                'name' => $route->getName(),
                'action' => is_string($action) ? $action : 'Closure',
                'middleware' => array_values(array_unique($route->gatherMiddleware())),
                'params' => array_values($route->parameterNames()),
            ];
        }
        usort($out, static fn (array $a, array $b): int => [$a['uri'], $a['methods'][0] ?? ''] <=> [$b['uri'], $b['methods'][0] ?? '']);
        return $out;
    }
}
