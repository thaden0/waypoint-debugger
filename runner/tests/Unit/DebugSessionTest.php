<?php

declare(strict_types=1);

namespace Waypoint\Runner\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Waypoint\Runner\Debug\DebugManager;

/**
 * Drives the interactive debug subprocess end-to-end: start -> pause at a
 * breakpoint -> step -> continue -> finish. Exercises DebugManager + debug-run.php
 * + the interactive Breakpoint pause/resume against the bare fixture.
 */
final class DebugSessionTest extends TestCase
{
    public function testPauseStepContinue(): void
    {
        $runnerDir = dirname(__DIR__, 2);
        $source = (string) file_get_contents(__DIR__ . '/../fixtures/OrderService.php');
        $taxLine = $this->lineOf($source, '$tax = $this->tax($subtotal);');

        $debug = new DebugManager();
        $started = $debug->start($runnerDir, [
            'projectRoot' => __DIR__,
            'driver' => 'bare',
            'source' => $source,
            'class' => 'OrderService',
            'method' => 'process',
            'args' => [[['price' => 10.0], ['price' => 5.5]]],
            'breakpoints' => [['line' => $taxLine]],
        ]);
        $this->assertTrue($started['ok']);

        $pauses = [];
        $finished = null;
        $deadline = microtime(true) + 10;

        while ($finished === null && microtime(true) < $deadline) {
            $out = $debug->stdout();
            if ($out === null) {
                break;
            }
            $read = [$out];
            $w = null;
            $e = null;
            @stream_select($read, $w, $e, 0, 100000);
            foreach ($debug->readAvailable() as $msg) {
                $method = $msg['method'] ?? '';
                if ($method === 'debug.paused') {
                    $pauses[] = $msg['params'];
                    // first pause is the breakpoint -> step once; second -> continue
                    $debug->send(count($pauses) === 1 ? 'step' : 'continue');
                } elseif ($method === 'debug.finished') {
                    $finished = $msg['params'];
                }
            }
        }

        $this->assertGreaterThanOrEqual(2, count($pauses), 'breakpoint pause + at least one step');

        // first pause: the breakpoint on the tax line, subtotal in scope
        $this->assertSame($taxLine, $pauses[0]['line']);
        $this->assertArrayHasKey('subtotal', $pauses[0]['scope']);
        $this->assertSame(15.5, $pauses[0]['scope']['subtotal']['preview']);

        // second pause: stepping advanced execution. The tax line calls tax(), so
        // a single step descends into it (step-into) — a different line, in tax()'s
        // scope. The point is that step() paused again at a new location.
        $this->assertNotSame($taxLine, $pauses[1]['line']);
        $this->assertArrayHasKey('this', $pauses[1]['scope']);

        $this->assertNotNull($finished);
        $this->assertTrue($finished['ok']);
        $this->assertSame(17.05, $finished['result']['total']);

        $debug->stop();
    }

    private function lineOf(string $source, string $needle): int
    {
        foreach (explode("\n", $source) as $i => $line) {
            if (str_contains($line, $needle)) {
                return $i + 1;
            }
        }
        $this->fail("no line containing: {$needle}");
    }
}
