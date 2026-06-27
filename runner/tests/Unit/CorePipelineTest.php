<?php

declare(strict_types=1);

namespace Waypoint\Runner\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Reconstruct\Invoker;
use Waypoint\Runner\Structure\StructureExtractor;
use Waypoint\Runner\Swap\ProblemScanner;
use Waypoint\Runner\Swap\Swapper;
use Waypoint\Runner\Waypoint\WaypointInstrumenter;

final class CorePipelineTest extends TestCase
{
    private string $source;

    protected function setUp(): void
    {
        $this->source = (string) file_get_contents(__DIR__ . '/../fixtures/UserController.php');
    }

    public function testStructureExtractionTagsWaypointEligibility(): void
    {
        $structure = (new StructureExtractor())->extractFile('UserController.php', $this->source);
        $class = $structure['nodes'][0];

        $this->assertSame('UserController', $class['name']);
        $this->assertSame('App\\Http\\Controllers', $structure['namespace']);

        $byName = array_column($class['members'], null, 'name');
        $this->assertTrue($byName['show']['waypointEligible'], 'public method is a valid waypoint');
        $this->assertFalse($byName['audit']['waypointEligible'], 'protected method is not');
    }

    public function testProblemScannerFlagsTheRightCategories(): void
    {
        $cats = array_column((new ProblemScanner())->scan($this->source), 'category');
        $this->assertContains('external.db', $cats);
        $this->assertContains('nondeterministic.random', $cats);
        $this->assertContains('nondeterministic.time', $cats);
    }

    public function testSwapperRewritesRhsFormatPreserving(): void
    {
        $line = $this->lineContaining('User::findOrFail');
        $indirect = (new Swapper())->apply($this->source, [['line' => $line, 'mode' => 'indirect', 'key' => 'user_1']]);
        $this->assertSame(1, $indirect['applied']);
        $this->assertStringContainsString("__waypointSwaps['user_1']", $indirect['source']);
        $this->assertStringContainsString('public function store(Request $request)', $indirect['source']);

        $replace = (new Swapper())->apply($this->source, [['line' => $line, 'mode' => 'replace', 'expression' => '$mockUser']]);
        $this->assertStringContainsString('$user = $mockUser;', $replace['source']);
    }

    public function testWaypointInstrumenterInjectsCaptureHook(): void
    {
        $line = $this->lineContaining('public function show(');
        $result = (new WaypointInstrumenter())->instrument($this->source, [['line' => $line, 'id' => 'UserController::show']]);
        $this->assertCount(1, $result['instrumented']);
        $this->assertStringContainsString('Waypoint\\Runner\\Capture\\Recorder::capture', $result['source']);
        $this->assertStringContainsString('func_get_args()', $result['source']);
    }

    public function testReconstructAndInvokeRollsBackInPeekMode(): void
    {
        Recorder::reset();
        Recorder::capture('Adder::add', new TestAdder(), [5]);
        $entry = Recorder::entry(0);
        $this->assertTrue($entry['reproducible']);

        $rolledBack = false;
        $invoker = new Invoker(
            begin: static function (): void {},
            commit: static function (): void {},
            rollback: static function () use (&$rolledBack): void { $rolledBack = true; },
        );
        $out = $invoker->invoke($entry, 'add', 'peek');

        $this->assertTrue($out['ok']);
        $this->assertSame(15, $out['result']);
        $this->assertTrue($rolledBack);
        $this->assertFalse($out['committed']);
    }

    public function testTierThreeValuesAreRefusedNotExploded(): void
    {
        $snapshot = Recorder::snapshotValue(static fn () => 1);
        $this->assertSame(3, $snapshot['tier']);
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

class TestAdder
{
    public int $base = 10;

    public function add(int $n): int
    {
        return $this->base + $n;
    }
}
