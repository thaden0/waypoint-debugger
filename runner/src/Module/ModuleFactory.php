<?php

declare(strict_types=1);

namespace Waypoint\Runner\Module;

use Waypoint\Modules\Bare\BareModule;
use Waypoint\Modules\Laravel\LaravelModule;

/**
 * Picks the framework module for a project root — the module analogue of
 * HostFactory. Step 3 replaces this hardcoded mapping with manifest-driven
 * detection (ModuleRegistry scanning modules/*\/module.json), so adding a
 * framework needs no edit here.
 */
final class ModuleFactory
{
    public static function for(string $root, ?string $force = null): FrameworkModule
    {
        return ModuleRegistry::default()->resolve($root, $force);
    }
}
