<?php

declare(strict_types=1);

namespace Waypoint\Runner\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Waypoint\Runner\Capture\Recorder;
use Waypoint\Runner\Host\BareHost;
use Waypoint\Runner\Host\HostFactory;
use Waypoint\Runner\Reconstruct\Invoker;
use Waypoint\Runner\Rpc\Notifier;
use Waypoint\Runner\Rpc\WebSocketFrame;
use Waypoint\Runner\Run\SliceRunner;

final class HostRunTest extends TestCase
{
    protected function tearDown(): void
    {
        Notifier::setSink(null);
        Recorder::reset();
    }

    public function testHostFactoryFallsBackToBare(): void
    {
        $host = HostFactory::for('/definitely/not/a/laravel/app');
        $this->assertSame('bare', $host->describe()['driver']);
    }

    public function testBareTransactionHooksTrackDepth(): void
    {
        $host = new BareHost('/tmp');
        [$begin, , $rollback] = $host->transactionHooks();
        $begin();
        $rollback();
        $this->assertSame(['begin', 'rollback'], $host->txLog);
    }

    public function testSliceRunCapturesWaypointsAcrossNestedCalls(): void
    {
        Recorder::reset();
        $host = new BareHost(__DIR__);
        $source = (string) file_get_contents(__DIR__ . '/../fixtures/OrderService.php');

        $waypointLines = $this->methodLines($source, ['process', 'subtotal', 'tax']);
        $items = [['price' => 10.0], ['price' => 5.5]];

        $runner = new SliceRunner($host);
        $result = $runner->run([
            'source' => $source,
            'class' => 'OrderService',
            'method' => 'process',
            'args' => [$items],
            'waypoints' => array_map(fn ($l) => ['line' => $l], $waypointLines),
        ]);

        $this->assertTrue($result['ok'], $result['error'] ?? '');
        $this->assertSame(15.5, $result['result']['subtotal']);
        $this->assertSame(1.55, $result['result']['tax']);

        // process + subtotal + tax each captured once.
        $ledger = Recorder::ledger();
        $ids = array_column($ledger, 'id');
        $this->assertContains('OrderService::process', $ids);
        $this->assertContains('OrderService::subtotal', $ids);
        $this->assertContains('OrderService::tax', $ids);
    }

    public function testReplayFromCapturedWaypointReproducesResult(): void
    {
        Recorder::reset();
        $host = new BareHost(__DIR__);
        $source = (string) file_get_contents(__DIR__ . '/../fixtures/OrderService.php');
        $taxLine = $this->methodLines($source, ['tax'])[0];

        (new SliceRunner($host))->run([
            'source' => $source,
            'class' => 'OrderService',
            'method' => 'process',
            'args' => [[['price' => 100.0]]],
            'waypoints' => [['line' => $taxLine]],
        ]);

        // Find the captured tax() entry and re-invoke it in peek mode.
        $taxEntry = null;
        foreach (Recorder::ledger() as $e) {
            if ($e['id'] === 'OrderService::tax') {
                $taxEntry = Recorder::entry($e['seq']);
                break;
            }
        }
        $this->assertNotNull($taxEntry, 'tax() should have been captured');

        [$begin, $commit, $rollback] = $host->transactionHooks();
        $out = (new Invoker($begin, $commit, $rollback))->invoke($taxEntry, 'tax', 'peek');

        $this->assertTrue($out['ok'], $out['error'] ?? '');
        $this->assertSame(10.0, $out['result']); // 100 * 0.1
        $this->assertFalse($out['committed']);
        $this->assertSame('rollback', end($host->txLog));
    }

    public function testCaptureEmitsLiveNotification(): void
    {
        Recorder::reset();
        $captured = [];
        Notifier::setSink(function (array $msg) use (&$captured): void {
            if (($msg['method'] ?? '') === 'ledger.captured') {
                $captured[] = $msg['params']['id'];
            }
        });

        Recorder::capture('Demo::a', new \stdClass(), [1]);
        Recorder::capture('Demo::b', new \stdClass(), [2]);

        $this->assertSame(['Demo::a', 'Demo::b'], $captured);
    }

    public function testWebSocketFrameRoundTripWithMask(): void
    {
        $payload = json_encode(['jsonrpc' => '2.0', 'id' => 7, 'method' => 'runner.info']);

        // Build a client-style masked frame and decode it.
        $masked = $this->maskedClientFrame($payload);
        $decoded = WebSocketFrame::decode($masked);

        $this->assertNotNull($decoded);
        $this->assertSame(WebSocketFrame::OP_TEXT, $decoded['opcode']);
        $this->assertSame($payload, $decoded['payload']);
        $this->assertSame(strlen($masked), $decoded['consumed']);

        // Partial buffer returns null until complete.
        $this->assertNull(WebSocketFrame::decode(substr($masked, 0, 3)));
    }

    public function testWebSocketAcceptKeyMatchesRfcExample(): void
    {
        // RFC 6455 §1.3 worked example.
        $this->assertSame(
            's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
            WebSocketFrame::acceptKey('dGhlIHNhbXBsZSBub25jZQ==')
        );
    }

    /** @param array<int,string> $names @return array<int,int> */
    private function methodLines(string $source, array $names): array
    {
        $lines = explode("\n", $source);
        $out = [];
        foreach ($names as $name) {
            foreach ($lines as $i => $line) {
                if (str_contains($line, "function {$name}(")) {
                    $out[] = $i + 1;
                    break;
                }
            }
        }
        return $out;
    }

    private function maskedClientFrame(string $payload): string
    {
        $len = strlen($payload);
        $frame = chr(0x80 | WebSocketFrame::OP_TEXT);
        if ($len <= 125) {
            $frame .= chr(0x80 | $len);
        } else {
            $frame .= chr(0x80 | 126) . pack('n', $len);
        }
        $mask = 'abcd';
        $frame .= $mask;
        for ($i = 0; $i < $len; $i++) {
            $frame .= $payload[$i] ^ $mask[$i % 4];
        }
        return $frame;
    }
}
