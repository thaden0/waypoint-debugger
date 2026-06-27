<?php

declare(strict_types=1);

namespace Waypoint\Runner\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Instrument\InstrumentingStreamWrapper;
use Waypoint\Runner\Run\RequestRunner;

final class IncludeInstrumentationTest extends TestCase
{
    private string $tmpDir;

    protected function setUp(): void
    {
        $this->tmpDir = sys_get_temp_dir() . '/wp_inst_' . bin2hex(random_bytes(4));
        mkdir($this->tmpDir, 0777, true);
        Recorder::reset();
    }

    protected function tearDown(): void
    {
        InstrumentingStreamWrapper::deactivate();
        Recorder::reset();
        array_map('unlink', glob($this->tmpDir . '/*.php') ?: []);
        @rmdir($this->tmpDir);
    }

    public function testWrapperInstrumentsTargetOnIncludeAndPassesOthersThrough(): void
    {
        // A target file (instrumented) and a plain file (pass-through).
        $targetFile = $this->tmpDir . '/Widget.php';
        $plainFile = $this->tmpDir . '/plain.php';
        file_put_contents($targetFile, "<?php\nclass Widget_" . getmypid() . " {\n    public function spin(int \$n): int {\n        return \$n * 2;\n    }\n}\n");
        file_put_contents($plainFile, "<?php\n\$GLOBALS['wp_plain_loaded'] = true;\n");

        $widgetClass = 'Widget_' . getmypid();
        $spinLine = 3; // "public function spin(...)" line in the generated file

        InstrumentingStreamWrapper::activate($this->tmpDir, [
            'Widget.php' => ['waypoints' => [['line' => $spinLine, 'id' => 'Widget::spin']]],
        ]);

        require $targetFile;  // routed through the wrapper -> instrumented
        require $plainFile;   // pass-through (not a target)

        $this->assertTrue($GLOBALS['wp_plain_loaded'] ?? false, 'non-target file still loads via pass-through');

        $widget = new $widgetClass();
        $out = $widget->spin(21);

        $this->assertSame(42, $out, 'instrumented method still returns correctly');
        $ids = array_column(Recorder::ledger(), 'id');
        $this->assertContains('Widget::spin', $ids, 'capture hook fired on the included target class');

        unset($GLOBALS['wp_plain_loaded']);
    }

    public function testWholeRequestCapturesAcrossFileBoundary(): void
    {
        $runnerDir = dirname(__DIR__, 2);
        $fixtureApp = dirname(__DIR__) . '/fixtures/app';

        $controllerSrc = (string) file_get_contents($fixtureApp . '/Http/CheckoutController.php');
        $serviceSrc = (string) file_get_contents($fixtureApp . '/Domain/PricingService.php');

        $config = [
            'projectRoot' => dirname(__DIR__) . '/fixtures',
            'driver' => 'bare',
            'psr4' => ['App\\' => $fixtureApp],
            'targets' => [
                'app/Http/CheckoutController.php' => ['waypoints' => [['line' => $this->lineOf($controllerSrc, 'function checkout(')]]],
                'app/Domain/PricingService.php' => ['waypoints' => [
                    ['line' => $this->lineOf($serviceSrc, 'function priceFor(')],
                    ['line' => $this->lineOf($serviceSrc, 'function tax(')],
                ]],
            ],
            'entry' => [
                'kind' => 'call',
                'class' => 'App\\Http\\CheckoutController',
                'method' => 'checkout',
                'args' => [[['price' => 100.0], ['price' => 50.0]]],
            ],
        ];

        $streamed = [];
        $result = (new RequestRunner($runnerDir))->run($config, function (array $entry) use (&$streamed): void {
            $streamed[] = $entry['id'];
        });

        $this->assertTrue($result['ok'], $result['error'] ?? 'run failed');
        // JSON transport collapses 180.0 -> 180; compare loosely.
        $this->assertEquals(180.0, $result['result']['total']); // 150 + 30 tax

        $ledgerIds = array_column($result['ledger'], 'id');
        // Captured across BOTH files.
        $this->assertContains('CheckoutController::checkout', $ledgerIds);
        $this->assertContains('PricingService::priceFor', $ledgerIds);
        $this->assertContains('PricingService::tax', $ledgerIds);

        // And those captures were streamed live (not just in the final result).
        $this->assertContains('PricingService::tax', $streamed);
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
