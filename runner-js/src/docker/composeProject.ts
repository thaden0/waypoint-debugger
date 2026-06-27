import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

// TS port of the PHP ComposeProject — same classification + reach logic, since
// compose is compose. Only the env-override mapping differs (Node conventions).

export interface PortMapping {
  published: number | null;
  target: number;
  hostIp: string | null;
  protocol: string;
}

export interface ServiceModel {
  name: string;
  image: string | null;
  build: boolean;
  command: string | null;
  role: 'app' | 'web' | 'dependency' | 'unknown';
  ports: PortMapping[];
  environment: Record<string, string>;
  dependsOn: string[];
}

const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const DEPENDENCY_IMAGES = [
  'mysql', 'mariadb', 'percona', 'postgres', 'postgis', 'redis', 'valkey', 'keydb',
  'memcached', 'mongo', 'rabbitmq', 'elasticsearch', 'opensearch', 'meilisearch',
  'minio', 'mailpit', 'mailhog', 'nats', 'kafka', 'soketi',
];
const APP_IMAGE_HINTS = ['node', 'bun', 'deno', 'nestjs', 'next'];
const APP_COMMAND_HINTS = ['node', 'npm', 'pnpm', 'yarn', 'bun', 'nest', 'next', 'vite', 'tsx', 'ts-node'];
const WEB_IMAGES = ['nginx', 'caddy', 'apache', 'httpd', 'traefik'];

export class ComposeProject {
  private constructor(public readonly path: string, private parsed: Record<string, any>) {}

  static find(root: string): string | null {
    for (const name of COMPOSE_NAMES) {
      const candidate = path.join(root, name);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  static load(file: string): ComposeProject {
    const parsed = parseYaml(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error(`compose file is not a mapping: ${file}`);
    return new ComposeProject(file, parsed);
  }

  services(): ServiceModel[] {
    const out: ServiceModel[] = [];
    const services = this.parsed.services ?? {};
    for (const [name, defRaw] of Object.entries(services)) {
      const def = (defRaw ?? {}) as Record<string, any>;
      const image = def.image ? String(def.image) : null;
      const build = def.build !== undefined;
      const command = stringifyCommand(def.command);
      out.push({
        name,
        image,
        build,
        command,
        role: classify(image, build, command),
        ports: parsePorts(def.ports ?? []),
        environment: parseEnvironment(def.environment ?? {}),
        dependsOn: parseDependsOn(def.depends_on ?? []),
      });
    }
    return out;
  }

  dependencyServices(): string[] {
    return this.services().filter((s) => s.role === 'dependency').map((s) => s.name);
  }

  appServices(): string[] {
    return this.services().filter((s) => s.role === 'app').map((s) => s.name);
  }

  defaultNetworkName(projectName: string): string {
    const networks = this.parsed.networks ?? {};
    for (const [name, def] of Object.entries(networks)) {
      if (def && typeof def === 'object' && (def as any).external) {
        return (def as any).name ?? name;
      }
    }
    return `${projectName}_default`;
  }
}

function classify(image: string | null, build: boolean, command: string | null): ServiceModel['role'] {
  const img = (image ?? '').toLowerCase();
  if (img && DEPENDENCY_IMAGES.some((d) => img.includes(d))) return 'dependency';
  if (img && WEB_IMAGES.some((w) => img.includes(w))) return 'web';
  if (build) return 'app';
  if (img && APP_IMAGE_HINTS.some((h) => img.includes(h))) return 'app';
  const cmd = (command ?? '').toLowerCase();
  if (cmd && APP_COMMAND_HINTS.some((h) => cmd.includes(h))) return 'app';
  return 'unknown';
}

function parsePorts(ports: unknown): PortMapping[] {
  if (!Array.isArray(ports)) return [];
  const out: PortMapping[] = [];
  for (const port of ports) {
    if (port && typeof port === 'object') {
      const p = port as Record<string, any>;
      out.push({
        published: p.published !== undefined ? Number(p.published) : null,
        target: Number(p.target ?? 0),
        hostIp: p.host_ip ? String(p.host_ip) : null,
        protocol: String(p.protocol ?? 'tcp'),
      });
    } else {
      out.push(parseShortPort(String(port)));
    }
  }
  return out.filter((p) => p.target > 0);
}

function parseShortPort(spec: string): PortMapping {
  let protocol = 'tcp';
  if (spec.includes('/')) [spec, protocol] = spec.split('/', 2);
  const parts = spec.split(':');
  let hostIp: string | null = null;
  let published: number | null = null;
  let target = 0;
  if (parts.length === 1) {
    target = Number(parts[0]);
  } else if (parts.length === 2) {
    published = parts[0] === '' ? null : Number(parts[0]);
    target = Number(parts[1]);
  } else {
    hostIp = parts[0];
    published = parts[1] === '' ? null : Number(parts[1]);
    target = Number(parts[2]);
  }
  return { published, target, hostIp, protocol };
}

function parseEnvironment(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(env)) {
    for (const line of env) {
      const s = String(line);
      const eq = s.indexOf('=');
      if (eq >= 0) out[s.slice(0, eq)] = s.slice(eq + 1);
    }
  } else if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) out[k] = v === null ? '' : String(v);
  }
  return out;
}

function parseDependsOn(dependsOn: unknown): string[] {
  if (Array.isArray(dependsOn)) return dependsOn.map(String);
  if (dependsOn && typeof dependsOn === 'object') return Object.keys(dependsOn);
  return [];
}

function stringifyCommand(command: unknown): string | null {
  if (Array.isArray(command)) return command.map(String).join(' ');
  return command === undefined || command === null ? null : String(command);
}
