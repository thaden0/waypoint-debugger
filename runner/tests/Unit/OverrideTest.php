<?php

declare(strict_types=1);

namespace Waypoint\Runner\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Waypoint\Runner\Debug\OverrideInstrumenter;
use Waypoint\Runner\Host\BareHost;
use Waypoint\Runner\Run\SliceRunner;

final class OverrideTest extends TestCase
{
    private string $source;

    protected function setUp(): void
    {
        $this->source = (string) file_get_contents(__DIR__ . '/../fixtures/OrderService.php');
    }

    public function testInstrumenterInjectsAssignmentBeforeLine(): void
    {
        $line = $this->lineOf('$tax = $this->tax($subtotal);');
        $result = (new OverrideInstrumenter())->apply($this->source, [
            ['line' => $line, 'var' => 'subtotal', 'expression' => '999'],
        ]);
        $this->assertCount(1, $result['applied']);
        $this->assertStringContainsString('$subtotal = 999;', $result['source']);
        // the override sits before the original statement
        $this->assertLessThan(
            strpos($result['source'], '$tax = $this->tax($subtotal)'),
            strpos($result['source'], '$subtotal = 999;')
        );
    }

    public function testReRunWithOverrideChangesTheResult(): void
    {
        // Original: process([10, 5.5]) -> subtotal 15.5, tax 1.55, total 17.05.
        // Override $subtotal := 100 right before tax is computed -> tax 10, total 110.
        $line = $this->lineOf('$tax = $this->tax($subtotal);');
        $out = (new SliceRunner(new BareHost(__DIR__)))->run([
            'source' => $this->source,
            'class' => 'OrderService',
            'method' => 'process',
            'args' => [[['price' => 10.0], ['price' => 5.5]]],
            'overrides' => [['line' => $line, 'var' => 'subtotal', 'expression' => '100']],
        ]);

        $this->assertTrue($out['ok'], $out['error'] ?? '');
        // The override sets $subtotal = 100 right before tax is computed, so the
        // rest of the method (tax and the returned subtotal) sees 100.
        $this->assertEquals(100, $out['result']['subtotal']);
        $this->assertEquals(10.0, $out['result']['tax']);    // tax(100) = 100 * 0.1
        $this->assertEquals(110.0, $out['result']['total']); // 100 + 10
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
