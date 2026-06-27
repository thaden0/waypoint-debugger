<?php

declare(strict_types=1);

namespace Waypoint\Runner\Host;

/**
 * The runner-as-host contract. The tool IS the runtime; the target app (Laravel)
 * is what it executes. A single long-lived process boots the app once and keeps
 * it resident, so the ledger persists, re-invokes are fast, and the booted
 * container supplies ambient state for reconstruct+invoke.
 *
 * Two implementations: LaravelHost (boots bootstrap/app.php, real DB + kernel)
 * and BareHost (no framework — exercises the full slice pipeline against plain
 * PHP, and is what runs when PROJECT_ROOT is not a Laravel app).
 */
interface HostInterface
{
    /** Boot the application once. Idempotent. */
    public function boot(): void;

    public function isBooted(): bool;

    /** @return array{driver:string,booted:bool,app:string,root:string} */
    public function describe(): array;

    /**
     * Reset per-request framework state between runs — the Octane/FrankenPHP
     * worker-mode gesture, reused here as the ledger-boundary reset.
     */
    public function resetState(): void;

    /**
     * Drive an entry and render the real response for the project-browser pane
     * and the API console. $options carries a faithful request beyond the query
     * params: ['headers'=>[name=>value], 'body'=>string, 'contentType'=>string,
     * 'cookies'=>[name=>value]]. The response includes real headers + duration.
     *
     * @return array{status:int,headers:array<string,string>,body:string,contentType:string,durationMs?:float}
     */
    public function renderEntry(string $method, string $uri, array $params = [], array $options = []): array;

    /**
     * Transaction guard hooks for the Invoker. With a real DB they map to
     * begin/commit/rollBack; in bare mode they track a flag so peek-vs-commit
     * is still observable. Returned as [begin, commit, rollback].
     *
     * @return array{0:callable():void,1:callable():void,2:callable():void}
     */
    public function transactionHooks(): array;

    /**
     * Resolve a class from the host's container if it can (Laravel), so a
     * receiver with constructor dependencies can be built for invoke. Returns
     * null when the host has no container or cannot construct it.
     */
    public function make(string $class): ?object;
}
