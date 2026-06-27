<?php

declare(strict_types=1);

namespace Waypoint\Runner\Workspace;

use Waypoint\Runner\Docker\Orchestrator;

/**
 * Detects whether a project is ready to debug and runs opt-in setup steps. Every
 * step is explicit (surfaced as a button, never automatic) because they touch the
 * user's app and DB. For dockerized projects "docker-up" reuses the existing
 * docker mode rather than provisioning a local PHP/DB environment.
 */
final class Provisioner
{
    public function __construct(private string $root)
    {
    }

    /**
     * @return array{provisioned:bool,issues:list<array{id:string,label:string,action:string}>,actions:list<array{id:string,label:string}>}
     */
    public function status(): array
    {
        $issues = [];
        $actions = [];

        if ($this->has('composer.json') && !$this->has('vendor')) {
            $issues[] = ['id' => 'deps', 'label' => 'Dependencies not installed (vendor/ missing)', 'action' => 'composer-install'];
        }
        if ($this->has('.env.example') && !$this->has('.env')) {
            $issues[] = ['id' => 'env', 'label' => 'No .env file', 'action' => 'env-setup'];
        }
        if ($this->has('artisan')) {
            $actions[] = ['id' => 'migrate', 'label' => 'Run migrations'];
        }
        if (Orchestrator::forRoot($this->root) !== null) {
            $actions[] = ['id' => 'docker-up', 'label' => 'Bring up Docker services'];
        }

        return ['provisioned' => $issues === [], 'issues' => $issues, 'actions' => $actions];
    }

    /** @return array{ok:bool,output?:string,error?:string} */
    public function provision(string $action): array
    {
        return match ($action) {
            'composer-install' => $this->run(['composer', 'install', '--no-interaction']),
            'env-setup' => $this->envSetup(),
            'migrate' => $this->run([PHP_BINARY, $this->root . '/artisan', 'migrate', '--force']),
            'docker-up' => $this->dockerUp(),
            default => ['ok' => false, 'error' => "unknown action: {$action}"],
        };
    }

    private function envSetup(): array
    {
        if (!$this->has('.env') && $this->has('.env.example')) {
            @copy($this->root . '/.env.example', $this->root . '/.env');
        }
        if (!$this->has('artisan')) {
            return ['ok' => true, 'output' => '.env created'];
        }
        return $this->run([PHP_BINARY, $this->root . '/artisan', 'key:generate']);
    }

    private function dockerUp(): array
    {
        $orch = Orchestrator::forRoot($this->root);
        if ($orch === null) {
            return ['ok' => false, 'error' => 'no compose file in project'];
        }
        $up = $orch->up();
        $reached = implode(', ', array_map(static fn ($t) => "{$t['service']}@127.0.0.1:{$t['port']}", $up['targets'] ?? []));
        return ['ok' => (bool) ($up['ok'] ?? false), 'output' => $reached !== '' ? "services up: {$reached}" : 'compose up complete'];
    }

    private function has(string $rel): bool
    {
        return file_exists($this->root . '/' . $rel);
    }

    /** @param list<string> $cmd */
    private function run(array $cmd): array
    {
        $proc = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $this->root);
        if (!is_resource($proc)) {
            return ['ok' => false, 'error' => 'failed to spawn ' . ($cmd[0] ?? '?')];
        }
        $out = stream_get_contents($pipes[1]);
        $errOut = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);
        return ['ok' => $code === 0, 'output' => trim($out . "\n" . $errOut)];
    }
}
