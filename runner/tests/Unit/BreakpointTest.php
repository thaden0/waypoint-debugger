<?php

declare(strict_types=1);

namespace Waypoint\Runner\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Waypoint\Runner\Debug\Breakpoint;
use Waypoint\Runner\Debug\BreakpointInstrumenter;
use Waypoint\Runner\Host\BareHost;
use Waypoint\Runner\Run\SliceRunner;

final class BreakpointTest extends TestCase
{
    private string $source;
    private int $taxLine;

    protected function setUp(): void
    {
        $this->source = (string) file_get_contents(__DIR__ . '/../fixtures/OrderService.php');
        $this->taxLine = $this->lineContaining('$tax = $this->tax($subtotal);');
        Breakpoint::reset();
    }

    protected function tearDown(): void
    {
        Breakpoint::setMode('halt');
        Breakpoint::reset();
    }

    public function testInstrumenterInsertsHookBeforeTheStatement(): void
    {
        $result = (new BreakpointInstrumenter())->instrument($this->source, [['line' => $this->taxLine, 'id' => 'bp1']]);
        $this->assertCount(1, $result['placed']);
        $this->assertStringContainsString('Waypoint\\Runner\\Debug\\Breakpoint::hit', $result['source']);
        $this->assertStringContainsString('get_defined_vars()', $result['source']);
        // The hook must appear before the tax assignment, with both on adjacent lines.
        $hookPos = strpos($result['source'], 'Breakpoint::hit');
        $stmtPos = strpos($result['source'], '$tax = $this->tax($subtotal)');
        $this->assertLessThan($stmtPos, $hookPos);
    }

    public function testHaltModeStopsAtLineAndCapturesScope(): void
    {
        $result = (new SliceRunner(new BareHost(__DIR__)))->run([
            'source' => $this->source,
            'class' => 'OrderService',
            'method' => 'process',
            'args' => [[['price' => 10.0], ['price' => 5.5]]],
            'breakpoints' => [['line' => $this->taxLine, 'id' => 'bp:tax']],
            'breakpointMode' => 'halt',
        ]);

        $this->assertTrue($result['ok'], $result['error'] ?? '');
        $this->assertTrue($result['paused'] ?? false, 'run paused at the breakpoint');
        $this->assertSame('bp:tax', $result['breakpoint']['id']);

        $scope = $result['breakpoint']['scope'];
        // At this line, $items and $subtotal are in scope; $tax is not yet.
        $this->assertArrayHasKey('subtotal', $scope);
        $this->assertArrayHasKey('items', $scope);
        $this->assertArrayHasKey('this', $scope);
        $this->assertArrayNotHasKey('tax', $scope);
        $this->assertSame(15.5, $scope['subtotal']['preview']);
    }

    public function testTraceModeRecordsHitsAndKeepsRunning(): void
    {
        $result = (new SliceRunner(new BareHost(__DIR__)))->run([
            'source' => $this->source,
            'class' => 'OrderService',
            'method' => 'process',
            'args' => [[['price' => 10.0], ['price' => 5.5]]],
            'breakpoints' => [['line' => $this->taxLine, 'id' => 'bp:tax']],
            'breakpointMode' => 'trace',
        ]);

        $this->assertTrue($result['ok'], $result['error'] ?? '');
        $this->assertFalse($result['paused'] ?? false, 'trace mode does not pause');
        $this->assertSame(1.55, $result['result']['tax']); // the run completed
        $hits = Breakpoint::hits();
        $this->assertCount(1, $hits);
        $this->assertSame(15.5, $hits[0]['scope']['subtotal']['preview']);
    }

    private function lineContaining(string $needle): int
    {
        foreach (explode("\n", $this->source) as $i => $line) {
            if (str_contains($line, $needle)) {
                return $i + 1;
            }
        }
        $this->fail("fixture has no line containing: {$needle}");
    }
}
