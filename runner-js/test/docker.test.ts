import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ComposeProject } from '../src/docker/composeProject.js';
import { Orchestrator } from '../src/docker/orchestrator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '../fixtures/docker/compose.full.yaml');
// Skip the real-container test in CI (kept fast/deterministic) — it runs locally.
const dockerUp = !process.env.CI && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

describe('compose parsing + classification', () => {
  it('classifies app / web / dependency', () => {
    const c = ComposeProject.load(fixture);
    const roles = Object.fromEntries(c.services().map((s) => [s.name, s.role]));
    expect(roles.app).toBe('app');
    expect(roles.worker).toBe('app');
    expect(roles.web).toBe('web');
    expect(roles.postgres).toBe('dependency');
    expect(roles.redis).toBe('dependency');
    expect(c.dependencyServices()).toEqual(['postgres', 'redis']);
    expect(c.appServices()).toEqual(['app', 'worker']);
  });

  it('resolves published vs network-join reach', () => {
    const scan = new Orchestrator(fixture, 'shop').scan() as any;
    expect(scan.reach.postgres.mode).toBe('published');
    expect(scan.reach.postgres.publishedPort).toBe(5433);
    expect(scan.reach.redis.mode).toBe('network-join');
    expect(scan.reach.redis.containerPort).toBe(6379);
  });

  it('maps postgres env to Node conventions', () => {
    const env = new Orchestrator(fixture, 'shop').envForService('postgres', 5433);
    expect(env.DATABASE_URL).toBe('postgresql://dev:secret@127.0.0.1:5433/shop');
    expect(env.PGHOST).toBe('127.0.0.1');
    expect(env.PGPORT).toBe('5433');
    expect(env.PGDATABASE).toBe('shop');
  });
});

describe.skipIf(!dockerUp)('real docker: redis up / reach / down', () => {
  let dir = '';
  afterEach(() => {
    if (dir) {
      Orchestrator.forRoot(dir)?.down();
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('brings up redis on a dynamic port, resolves it, reaches it', async () => {
    dir = path.join(here, '../.tmp-redis-' + Math.floor(process.hrtime()[1]));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  cache:\n    image: redis:7-alpine\n    ports:\n      - "6379"\n');

    const orch = Orchestrator.forRoot(dir)!;
    const up = orch.up();
    expect(up.ok).toBe(true);
    expect(up.targets).toHaveLength(1);
    const port = up.targets[0].port;
    expect(port).toBeGreaterThan(0);
    expect(up.env.REDIS_URL).toBe(`redis://127.0.0.1:${port}`);

    const pong = await pingRedis(port);
    expect(pong).toContain('+PONG');
  });
});

function pingRedis(port: number): Promise<string> {
  return new Promise(async (resolve) => {
    for (let i = 0; i < 30; i++) {
      const reply = await new Promise<string>((res) => {
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => sock.write('PING\r\n'));
        sock.setTimeout(2000);
        let buf = '';
        sock.on('data', (d) => { buf += d.toString(); sock.end(); });
        sock.on('close', () => res(buf));
        sock.on('error', () => res(''));
        sock.on('timeout', () => { sock.destroy(); res(''); });
      });
      if (reply.includes('+PONG')) return resolve(reply);
      await new Promise((r) => setTimeout(r, 100));
    }
    resolve('');
  });
}
