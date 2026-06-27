<?php

declare(strict_types=1);

namespace Waypoint\Runner\Host;

/**
 * A frameworkless host. It exercises the entire slice pipeline — boot, entry
 * render, transaction guard, reconstruct+invoke — without Laravel, so the tool
 * is runnable and testable against plain PHP and the bundled fixtures.
 *
 * The transaction hooks track a depth counter and a committed/rolled-back flag
 * instead of touching a real connection, so peek-vs-destructive is observable
 * in tests and in the UI before a DB is wired.
 */
final class BareHost implements HostInterface
{
    private bool $booted = false;
    private int $txDepth = 0;

    /** @var array<int,string> */
    public array $txLog = [];

    public function __construct(private string $root)
    {
    }

    public function boot(): void
    {
        $this->booted = true;
    }

    public function isBooted(): bool
    {
        return $this->booted;
    }

    public function describe(): array
    {
        return ['driver' => 'bare', 'booted' => $this->booted, 'app' => 'frameworkless', 'root' => $this->root];
    }

    public function resetState(): void
    {
        $this->txDepth = 0;
        $this->txLog = [];
    }

    public function renderEntry(string $method, string $uri, array $params = []): array
    {
        $body = "<!doctype html><html><body style=\"font-family:system-ui;padding:24px;color:#0f172a\">"
            . "<h2>Bare host</h2>"
            . "<p>No Laravel app at <code>" . htmlspecialchars($this->root) . "</code>.</p>"
            . "<p>Entry: <code>" . htmlspecialchars("$method $uri") . "</code></p>"
            . "<pre>" . htmlspecialchars(json_encode($params, JSON_PRETTY_PRINT)) . "</pre>"
            . "<p>Point <code>PROJECT_ROOT</code> at a Laravel app to render real responses here.</p>"
            . "</body></html>";

        return ['status' => 200, 'headers' => [], 'body' => $body, 'contentType' => 'text/html'];
    }

    public function transactionHooks(): array
    {
        return [
            function (): void {
                $this->txDepth++;
                $this->txLog[] = 'begin';
            },
            function (): void {
                $this->txDepth = max(0, $this->txDepth - 1);
                $this->txLog[] = 'commit';
            },
            function (): void {
                $this->txDepth = max(0, $this->txDepth - 1);
                $this->txLog[] = 'rollback';
            },
        ];
    }

    public function make(string $class): ?object
    {
        // No container; only constructable if it has no required constructor args.
        if (!class_exists($class)) {
            return null;
        }
        try {
            $ref = new \ReflectionClass($class);
            $ctor = $ref->getConstructor();
            if ($ctor !== null && $ctor->getNumberOfRequiredParameters() > 0) {
                return null;
            }
            return $ref->newInstance();
        } catch (\Throwable) {
            return null;
        }
    }
}
