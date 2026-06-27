<?php

declare(strict_types=1);

namespace Waypoint\Runner\Debug;

/** Thrown to unwind an interactive debug run when the user clicks "stop". */
final class StopRun extends \Exception
{
}
