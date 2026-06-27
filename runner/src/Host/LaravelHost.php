<?php

declare(strict_types=1);

namespace Waypoint\Runner\Host;

/**
 * Boots a real Laravel application from PROJECT_ROOT and keeps it resident. This
 * is the runner-as-host realization: the PHP that boots Laravel and the PHP that
 * is the tool are the same process. Under FrankenPHP/Octane worker mode this
 * process is long-lived and the app is booted once; resetState() is the
 * between-request reset the worker model already provides.
 *
 * Written against the stable Laravel bootstrap contract. It is only constructed
 * when PROJECT_ROOT looks like a Laravel app (HostFactory decides), so the
 * Illuminate classes referenced here exist at runtime.
 */
final class LaravelHost implements HostInterface
{
    private ?object $app = null;
    private ?object $kernel = null;

    public function __construct(private string $root)
    {
    }

    public function boot(): void
    {
        if ($this->app !== null) {
            return;
        }

        $autoload = $this->root . '/vendor/autoload.php';
        if (is_file($autoload)) {
            require_once $autoload;
        }

        /** @var object $app */
        $app = require $this->root . '/bootstrap/app.php';
        $this->app = $app;

        // Resolve the HTTP kernel and bootstrap the framework.
        $kernelContract = 'Illuminate\\Contracts\\Http\\Kernel';
        $this->kernel = $app->make($kernelContract);
        $this->kernel->bootstrap();
    }

    public function isBooted(): bool
    {
        return $this->app !== null;
    }

    public function describe(): array
    {
        $version = '';
        if ($this->app !== null && method_exists($this->app, 'version')) {
            $version = (string) $this->app->version();
        }
        return [
            'driver' => 'laravel',
            'booted' => $this->app !== null,
            'app' => $version !== '' ? "Laravel {$version}" : 'Laravel',
            'root' => $this->root,
        ];
    }

    public function resetState(): void
    {
        if ($this->app === null) {
            return;
        }
        // Simplified worker-style reset: drop request-scoped singletons so the
        // next entry rebuilds them. FrankenPHP/Octane provides the exhaustive
        // version (config, container bindings, facade roots); we lean on it when
        // present and keep this minimal otherwise.
        foreach (['request', 'session', 'auth'] as $abstract) {
            if (method_exists($this->app, 'forgetInstance')) {
                $this->app->forgetInstance($abstract);
            }
        }
    }

    public function renderEntry(string $method, string $uri, array $params = []): array
    {
        $this->boot();

        $requestClass = 'Illuminate\\Http\\Request';
        $request = $requestClass::create($uri, strtoupper($method), $params);

        /** @var object $response */
        $response = $this->kernel->handle($request);
        $body = (string) $response->getContent();
        $status = (int) $response->getStatusCode();
        $contentType = (string) $response->headers->get('Content-Type', 'text/html');

        if (method_exists($this->kernel, 'terminate')) {
            $this->kernel->terminate($request, $response);
        }
        $this->resetState();

        return ['status' => $status, 'headers' => [], 'body' => $body, 'contentType' => $contentType];
    }

    public function transactionHooks(): array
    {
        $db = fn () => $this->app?->make('db');
        return [
            function () use ($db): void { $db()?->beginTransaction(); },
            function () use ($db): void { $db()?->commit(); },
            function () use ($db): void { $db()?->rollBack(); },
        ];
    }

    public function make(string $class): ?object
    {
        try {
            return $this->app?->make($class);
        } catch (\Throwable) {
            return null;
        }
    }
}
