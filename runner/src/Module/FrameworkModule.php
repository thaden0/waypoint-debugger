<?php

declare(strict_types=1);

namespace Waypoint\Runner\Module;

use Waypoint\Runner\Host\HostInterface;

/**
 * The single thing you implement to add a framework to the platform. It composes
 * the framework-specific providers a language runner exposes over the protocol:
 * the runtime host (boot / request / transactions / container), the route schema
 * (api console), and the ORM (data console).
 *
 * A new framework = one FrameworkModule (+ a module.json manifest). The same UI
 * drives it, because the UI only ever talks to the protocol the providers back.
 */
interface FrameworkModule
{
    /** Stable id, e.g. "laravel" / "bare". */
    public function id(): string;

    /** The resident runtime. Memoized so the app boots once. */
    public function host(): HostInterface;

    /** Route introspection for the api console. */
    public function routes(): RouteProvider;

    /** The data console, or null if the framework has no ORM binding. */
    public function orm(): ?OrmProvider;
}
