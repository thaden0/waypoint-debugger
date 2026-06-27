import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ComposeProject, type ServiceModel } from './composeProject.js';

// TS port of the PHP Orchestrator. Brings up dependency services, reads their
// live published ports, and produces env overrides — here mapped to Node
// conventions (DATABASE_URL / REDIS_URL + the per-driver vars).

export interface ReachResolution {
  mode: 'published' | 'network-join';
  host?: string;
  publishedPort?: number | null;
  containerPort: number | null;
  note?: string;
}

export interface ConnectionTarget {
  service: string;
  image: string | null;
  host: string;
  port: number;
  containerPort: number;
}

export interface UpResult {
  ok: boolean;
  broughtUp: string[];
  targets: ConnectionTarget[];
  env: Record<string, string>;
  warnings: string[];
  error?: string;
}

export class Orchestrator {
  private compose: ComposeProject;

  constructor(private composePath: string, private projectName: string) {
    this.compose = ComposeProject.load(composePath);
  }

  static forRoot(root: string): Orchestrator | null {
    const file = ComposeProject.find(root);
    if (!file) return null;
    const project = path.basename(root).toLowerCase().replace(/[^a-z0-9]/g, '') || 'app';
    return new Orchestrator(file, project);
  }

  scan(): Record<string, unknown> {
    const services = this.compose.services();
    const reach: Record<string, ReachResolution> = {};
    for (const s of services) {
      if (s.role === 'dependency') reach[s.name] = this.resolveReach(s);
    }
    return {
      compose: this.composePath,
      project: this.projectName,
      services,
      app: this.compose.appServices(),
      dependencies: this.compose.dependencyServices(),
      reach,
      network: this.compose.defaultNetworkName(this.projectName),
    };
  }

  up(only?: string[] | null): UpResult {
    const deps = only ?? this.compose.dependencyServices();
    if (deps.length === 0) {
      return { ok: true, broughtUp: [], targets: [], env: {}, warnings: ['no dependency services found in compose'] };
    }

    const up = this.dockerCompose(['up', '-d', ...deps], 180_000);
    if (up.code !== 0) {
      return { ok: false, broughtUp: [], targets: [], env: {}, warnings: [], error: up.err.trim() || 'docker compose up failed' };
    }

    const byName = new Map(this.compose.services().map((s) => [s.name, s]));
    const targets: ConnectionTarget[] = [];
    let env: Record<string, string> = {};
    const warnings: string[] = [];

    for (const dep of deps) {
      const svc = byName.get(dep);
      if (!svc) continue;
      const containerPort = svc.ports[0]?.target ?? defaultPortFor(svc.image);
      if (containerPort == null) {
        warnings.push(`${dep}: no port to resolve`);
        continue;
      }
      const hostPort = this.livePublishedPort(dep, containerPort);
      if (hostPort == null) {
        warnings.push(`${dep}: not published on the host — network-join required to reach it`);
        continue;
      }
      const target: ConnectionTarget = { service: dep, image: svc.image, host: '127.0.0.1', port: hostPort, containerPort };
      targets.push(target);
      env = { ...env, ...envFor(svc, target) };
    }

    return { ok: true, broughtUp: deps, targets, env, warnings };
  }

  down(): { ok: boolean; error?: string } {
    const r = this.dockerCompose(['down'], 120_000);
    return { ok: r.code === 0, error: r.code === 0 ? undefined : r.err.trim() };
  }

  /** Env overrides for a named dependency at a host port — for testing the mapping. */
  envForService(serviceName: string, hostPort: number, host = '127.0.0.1'): Record<string, string> {
    const svc = this.compose.services().find((s) => s.name === serviceName);
    return svc ? envFor(svc, { service: serviceName, image: svc.image, host, port: hostPort, containerPort: 0 }) : {};
  }

  private resolveReach(service: ServiceModel): ReachResolution {
    for (const p of service.ports) {
      if (p.target > 0) {
        return { mode: 'published', host: '127.0.0.1', publishedPort: p.published, containerPort: p.target };
      }
    }
    return {
      mode: 'network-join',
      containerPort: defaultPortFor(service.image),
      note: 'dependency publishes no host port; join the compose network to reach it by service name',
    };
  }

  private livePublishedPort(service: string, containerPort: number): number | null {
    const r = this.dockerCompose(['port', service, String(containerPort)], 30_000);
    if (r.code !== 0) return null;
    const out = r.out.trim();
    if (!out.includes(':')) return null;
    const port = Number(out.slice(out.lastIndexOf(':') + 1));
    return port > 0 ? port : null;
  }

  private dockerCompose(args: string[], timeout: number): { code: number; out: string; err: string } {
    const r = spawnSync('docker', ['compose', '-p', this.projectName, '-f', this.composePath, ...args], {
      encoding: 'utf8',
      timeout,
    });
    return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? (r.error ? r.error.message : '') };
  }
}

function envFor(svc: ServiceModel, target: ConnectionTarget): Record<string, string> {
  const img = (svc.image ?? '').toLowerCase();
  const e = svc.environment;
  const { host, port } = target;

  if (img.includes('postgres') || img.includes('postgis')) {
    const db = e.POSTGRES_DB ?? 'app';
    const user = e.POSTGRES_USER ?? 'postgres';
    const pass = e.POSTGRES_PASSWORD ?? '';
    return {
      DATABASE_URL: `postgresql://${user}:${pass}@${host}:${port}/${db}`,
      PGHOST: host, PGPORT: String(port), PGUSER: user, PGPASSWORD: pass, PGDATABASE: db,
    };
  }
  if (img.includes('mysql') || img.includes('mariadb') || img.includes('percona')) {
    const db = e.MYSQL_DATABASE ?? 'app';
    const user = e.MYSQL_USER ?? 'root';
    const pass = e.MYSQL_PASSWORD ?? e.MYSQL_ROOT_PASSWORD ?? '';
    return {
      DATABASE_URL: `mysql://${user}:${pass}@${host}:${port}/${db}`,
      MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_USER: user, MYSQL_PASSWORD: pass, MYSQL_DATABASE: db,
    };
  }
  if (img.includes('redis') || img.includes('valkey') || img.includes('keydb')) {
    return { REDIS_URL: `redis://${host}:${port}`, REDIS_HOST: host, REDIS_PORT: String(port) };
  }
  if (img.includes('mongo')) {
    return { MONGODB_URI: `mongodb://${host}:${port}`, MONGO_HOST: host, MONGO_PORT: String(port) };
  }
  if (img.includes('memcached')) {
    return { MEMCACHED_HOST: host, MEMCACHED_PORT: String(port) };
  }
  return {};
}

function defaultPortFor(image: string | null): number | null {
  const img = (image ?? '').toLowerCase();
  if (img.includes('postgres') || img.includes('postgis')) return 5432;
  if (img.includes('mysql') || img.includes('mariadb') || img.includes('percona')) return 3306;
  if (img.includes('redis') || img.includes('valkey') || img.includes('keydb')) return 6379;
  if (img.includes('mongo')) return 27017;
  if (img.includes('memcached')) return 11211;
  return null;
}
