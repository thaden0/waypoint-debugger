<?php

declare(strict_types=1);

namespace Waypoint\Runner\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Waypoint\Runner\Docker\ComposeProject;
use Waypoint\Runner\Docker\Orchestrator;

final class DockerTest extends TestCase
{
    private string $fixture;

    protected function setUp(): void
    {
        $this->fixture = __DIR__ . '/../fixtures/docker/compose.full.yaml';
    }

    public function testClassifiesServices(): void
    {
        $compose = ComposeProject::load($this->fixture);
        $roles = [];
        foreach ($compose->services() as $s) {
            $roles[$s['name']] = $s['role'];
        }

        $this->assertSame('app', $roles['app']);       // build context
        $this->assertSame('app', $roles['queue']);     // build + artisan command
        $this->assertSame('web', $roles['web']);       // nginx
        $this->assertSame('dependency', $roles['mysql']);
        $this->assertSame('dependency', $roles['redis']);

        $this->assertSame(['mysql', 'redis'], $compose->dependencyServices());
        $this->assertSame(['app', 'queue'], $compose->appServices());
    }

    public function testParsesPublishedPorts(): void
    {
        $compose = ComposeProject::load($this->fixture);
        $mysql = $this->serviceNamed($compose, 'mysql');
        $this->assertSame(3307, $mysql['ports'][0]['published']);
        $this->assertSame(3306, $mysql['ports'][0]['target']);
    }

    public function testResolvesReachPublishedVsNetworkJoin(): void
    {
        $orch = new Orchestrator($this->fixture, 'shop');
        $scan = $orch->scan();

        $this->assertSame('published', $scan['reach']['mysql']['mode']);
        $this->assertSame(3307, $scan['reach']['mysql']['publishedPort']);
        $this->assertSame(3306, $scan['reach']['mysql']['containerPort']);

        // redis publishes nothing -> a host-side runner needs to join the network.
        $this->assertSame('network-join', $scan['reach']['redis']['mode']);
        $this->assertSame(6379, $scan['reach']['redis']['containerPort']);
    }

    public function testEnvOverridesForMysqlFromServiceEnvironment(): void
    {
        $orch = new Orchestrator($this->fixture, 'shop');
        $env = $orch->envForService('mysql', 3307);

        $this->assertSame('mysql', $env['DB_CONNECTION']);
        $this->assertSame('127.0.0.1', $env['DB_HOST']);
        $this->assertSame('3307', $env['DB_PORT']);
        $this->assertSame('shop', $env['DB_DATABASE']);
        $this->assertSame('dev', $env['DB_USERNAME']);
        $this->assertSame('secret', $env['DB_PASSWORD']);
    }

    public function testShortPortFormVariants(): void
    {
        $yaml = "services:\n  db:\n    image: postgres:16-alpine\n    ports:\n      - \"127.0.0.1:55432:5432\"\n";
        $tmp = sys_get_temp_dir() . '/wp_compose_' . bin2hex(random_bytes(3)) . '.yaml';
        file_put_contents($tmp, $yaml);
        try {
            $orch = new Orchestrator($tmp, 'p');
            $env = $orch->envForService('db', 55432);
            $this->assertSame('pgsql', $env['DB_CONNECTION']);
            $reach = $orch->scan()['reach']['db'];
            $this->assertSame(55432, $reach['publishedPort']);
        } finally {
            @unlink($tmp);
        }
    }

    private function serviceNamed(ComposeProject $c, string $name): array
    {
        foreach ($c->services() as $s) {
            if ($s['name'] === $name) {
                return $s;
            }
        }
        $this->fail("no service {$name}");
    }
}
