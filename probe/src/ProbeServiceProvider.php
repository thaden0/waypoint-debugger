<?php

declare(strict_types=1);

namespace Waypoint\Probe;

use Illuminate\Contracts\Debug\ExceptionHandler;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\ServiceProvider;
use Waypoint\Probe\Buffer\Buffer;
use Waypoint\Probe\Buffer\BufferFactory;

/**
 * Wires the probe into a Laravel app — but only when ARMED (enabled + a secret).
 * Fails closed: unconfigured, it registers nothing that exposes data.
 */
final class ProbeServiceProvider extends ServiceProvider
{
    private const LEVELS = ['debug' => 100, 'info' => 200, 'notice' => 250, 'warning' => 300, 'error' => 400, 'critical' => 500, 'alert' => 550, 'emergency' => 600];

    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../config/waypoint-probe.php', 'waypoint-probe');
        $this->app->singleton(Buffer::class, fn ($app) => BufferFactory::make($app['config']->get('waypoint-probe.buffer', [])));
        $this->app->singleton(Recorder::class, fn ($app) => new Recorder($app['config']->get('waypoint-probe.redact', [])));

        // Capture reported exceptions structurally by decorating the handler — the
        // reliable point (the routing pipeline hides them from middleware).
        if ($this->armed() && $this->app['config']->get('waypoint-probe.capture.exceptions', true)) {
            $this->app->extend(ExceptionHandler::class, fn ($handler, $app) => new ProbeExceptionHandler(
                $handler,
                $app->make(Buffer::class),
                $app->make(Recorder::class),
                $app,
            ));
        }
    }

    public function boot(): void
    {
        $this->publishes([__DIR__ . '/../config/waypoint-probe.php' => $this->app->configPath('waypoint-probe.php')], 'waypoint-probe');

        if (!$this->armed()) {
            return; // fail closed
        }

        $config = $this->app['config'];
        $path = (string) $config->get('waypoint-probe.path', '_waypoint/probe');

        // Bare routes (no web/CSRF middleware) — auth is the shared secret.
        $router = $this->app['router'];
        $router->get($path, [ProbeController::class, 'pull']);
        $router->post($path, [ProbeController::class, 'config']);

        // Capture log events at/above the configured level (framework event — no
        // Monolog-version coupling). Skip records that carry an exception — those
        // are captured structurally by the handler decorator (avoid duplicates).
        if ($config->get('waypoint-probe.capture.logs', true)) {
            $min = self::LEVELS[strtolower((string) $config->get('waypoint-probe.capture.log_level', 'error'))] ?? 400;
            $this->app['events']->listen(MessageLogged::class, function (MessageLogged $e) use ($min): void {
                if ((self::LEVELS[strtolower($e->level)] ?? 0) < $min || isset($e->context['exception'])) {
                    return;
                }
                try {
                    $this->app->make(Buffer::class)->push($this->app->make(Recorder::class)->logRecord($e->level, $e->message, $e->context));
                } catch (\Throwable) {
                    // never break the app
                }
            });
        }
    }

    private function armed(): bool
    {
        $config = $this->app['config'];
        return (bool) $config->get('waypoint-probe.enabled') && (string) $config->get('waypoint-probe.secret') !== '';
    }
}
