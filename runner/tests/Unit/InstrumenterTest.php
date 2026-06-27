<?php

declare(strict_types=1);

namespace Waypoint\Runner\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Host\BareHost;
use Waypoint\Runner\Instrument\Instrumenter;
use Waypoint\Runner\Run\SliceRunner;

final class InstrumenterTest extends TestCase
{
    private string $source;

    protected function setUp(): void
    {
        $this->source = (string) file_get_contents(__DIR__ . '/../fixtures/OrderService.php');
        Recorder::reset();
    }

    public function testSinglePassPlacesEveryOpAtItsOriginalLine(): void
    {
        $wpLine = $this->lineOf('public function process(');
        $bpLine = $this->lineOf('$tax = $this->tax($subtotal);');

        $out = (new Instrumenter())->apply($this->source, [
            'waypoints' => [['line' => $wpLine, 'id' => 'OrderService::process']],
            'breakpoints' => [['line' => $bpLine, 'id' => 'bp:tax']],
        ]);

        // both hooks present, and the breakpoint sits right before the tax line
        $this->assertStringContainsString('Recorder::capture', $out);
        $this->assertStringContainsString('Breakpoint::hit', $out);
        $bpPos = strpos($out, 'Breakpoint::hit');
        $taxPos = strpos($out, '$tax = $this->tax($subtotal)');
        $this->assertLessThan($taxPos, $bpPos);
        // and the breakpoint hook comes AFTER the subtotal assignment (not before it)
        $subtotalPos = strpos($out, '$subtotal = $this->subtotal($items)');
        $this->assertLessThan($bpPos, $subtotalPos);
    }

    public function testWaypointAndBreakpointCombineWithoutLineShift(): void
    {
        // The waypoint injects a hook at the method entry, which used to push the
        // breakpoint a line off. With one pass it lands correctly: the breakpoint
        // on the tax line halts AFTER subtotal is computed.
        $wpLine = $this->lineOf('public function process(');
        $bpLine = $this->lineOf('$tax = $this->tax($subtotal);');

        $result = (new SliceRunner(new BareHost(__DIR__)))->run([
            'source' => $this->source,
            'class' => 'OrderService',
            'method' => 'process',
            'args' => [[['price' => 10.0], ['price' => 5.5]]],
            'waypoints' => [['line' => $wpLine]],
            'breakpoints' => [['line' => $bpLine, 'id' => 'bp:tax']],
            'breakpointMode' => 'halt',
        ]);

        $this->assertTrue($result['ok'], $result['error'] ?? '');
        $this->assertTrue($result['paused'] ?? false);
        $this->assertSame('bp:tax', $result['breakpoint']['id']);

        // Halted on the tax line -> subtotal is in scope (would be absent if the
        // breakpoint had shifted up to the subtotal line).
        $scope = $result['breakpoint']['scope'];
        $this->assertArrayHasKey('subtotal', $scope);
        $this->assertSame(15.5, $scope['subtotal']['preview']);
        $this->assertArrayNotHasKey('tax', $scope);

        // The waypoint also fired (process captured) before the halt.
        $this->assertContains('OrderService::process', array_column(Recorder::ledger(), 'id'));
    }

    private function lineOf(string $needle): int
    {
        foreach (explode("\n", $this->source) as $i => $line) {
            if (str_contains($line, $needle)) {
                return $i + 1;
            }
        }
        $this->fail("no line containing: {$needle}");
    }
}
