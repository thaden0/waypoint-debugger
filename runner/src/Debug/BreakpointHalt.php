<?php

declare(strict_types=1);

namespace Waypoint\Runner\Debug;

/**
 * Thrown by an injected breakpoint hook in "halt" mode to stop the run at that
 * line, carrying the captured local scope back to the runner. Caught at the run
 * boundary and turned into a "paused at line N" result — run-to-breakpoint, the
 * snapshot-and-inspect analog of a step-debugger pause.
 */
final class BreakpointHalt extends \Exception
{
    /** @param array<string,mixed> $scope */
    public function __construct(
        public readonly string $bpId,
        public readonly array $scope,
    ) {
        parent::__construct("breakpoint halt: {$bpId}");
    }
}
