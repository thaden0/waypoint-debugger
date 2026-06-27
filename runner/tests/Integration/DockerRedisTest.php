<?php

declare(strict_types=1);

namespace Waypoint\Runner\Tests\Integration;

use PHPUnit\Framework\TestCase;
use Waypoint\Runner\Docker\Orchestrator;

/**
 * Real-docker proof of docker mode: bring up a dependency with a dynamic host
 * port, resolve the live mapping, and reach it from the host-side runner. Uses
 * redis:7-alpine (small, fast). Not in the default suite — run explicitly:
 *
 *   vendor/bin/phpunit tests/Integration
 */
final class DockerRedisTest extends TestCase
{
    private string $dir = '';

    protected function setUp(): void
    {
        exec('docker info >/dev/null 2>&1', $o, $code);
        if ($code !== 0) {
            $this->markTestSkipped('docker daemon not available');
        }
        $this->dir = sys_get_temp_dir() . '/wpredis' . bin2hex(random_bytes(3));
        mkdir($this->dir);
        file_put_contents($this->dir . '/compose.yaml',
            "services:\n  cache:\n    image: redis:7-alpine\n    ports:\n      - \"6379\"\n");
    }

    protected function tearDown(): void
    {
        if ($this->dir !== '' && is_dir($this->dir)) {
            $orch = Orchestrator::forRoot($this->dir);
            $orch?->down();
            @unlink($this->dir . '/compose.yaml');
            @rmdir($this->dir);
        }
    }

    public function testBringsUpRedisResolvesPortAndReachesIt(): void
    {
        $orch = Orchestrator::forRoot($this->dir);
        $this->assertNotNull($orch);

        $up = $orch->up();
        $this->assertTrue($up['ok'], $up['error'] ?? 'up failed');
        $this->assertCount(1, $up['targets']);

        $target = $up['targets'][0];
        $this->assertSame('cache', $target['service']);
        $this->assertSame('127.0.0.1', $target['host']);
        $this->assertGreaterThan(0, $target['port']);

        // Env overrides point Laravel's redis config at the host-mapped port.
        $this->assertSame('127.0.0.1', $up['env']['REDIS_HOST']);
        $this->assertSame((string) $target['port'], $up['env']['REDIS_PORT']);

        // Actually reach it: a host-side TCP connection + RESP PING. The container
        // reports "up" before redis is answering, so retry briefly for readiness.
        $reply = '';
        for ($i = 0; $i < 30; $i++) {
            $sock = @stream_socket_client("tcp://127.0.0.1:{$target['port']}", $errno, $errstr, 2);
            if ($sock !== false) {
                stream_set_timeout($sock, 2);
                fwrite($sock, "PING\r\n");
                $reply = (string) fread($sock, 16);
                fclose($sock);
                if (str_contains($reply, '+PONG')) {
                    break;
                }
            }
            usleep(100000);
        }
        $this->assertStringContainsString('+PONG', $reply, 'dockerized redis answered the host-side runner');
    }
}
