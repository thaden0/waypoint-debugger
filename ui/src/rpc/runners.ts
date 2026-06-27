import { WsClient, wsClient, DEFAULT_WS_URL } from './ws';

// Convention: the frontend (JS) runner is launched on ws+1 by the launcher.
export const FRONTEND_WS_URL = DEFAULT_WS_URL.replace(/(\d+)$/, (p) => String(Number(p) + 1));

// Multi-runner registry — the spine for debugging a backend + frontend together.
// The UI connects to one WS per runner (no broker) and routes a call to the right
// one by capability: cdp.* → a frontend runner, everything else → the backend.
// The existing `wsClient` is the primary/backend connection, so the single-runner
// path is unchanged.

export interface RunnerDescriptor {
  id: string;
  role: string; // backend | frontend | both
  url: string;
  language: string;
  capabilities: string[];
  projectRoot?: string;
}

interface RunnerInfoLike {
  language: string;
  role?: string;
  capabilities?: string[];
  projectRoot?: string;
}

class Runners {
  static BACKEND = 'backend';
  static FRONTEND = 'frontend';

  private conns = new Map<string, WsClient>([[Runners.BACKEND, wsClient]]);
  private metas = new Map<string, RunnerDescriptor>();

  /** Connect (or refresh) a runner and capture its descriptor. */
  async connect(id: string, url?: string): Promise<RunnerDescriptor | null> {
    const conn = this.conns.get(id) ?? new WsClient(url);
    this.conns.set(id, conn);
    const ok = await conn.connect();
    if (!ok) {
      this.conns.delete(id);
      this.metas.delete(id);
      return null;
    }
    try {
      const info = await conn.call<RunnerInfoLike>('runner.info');
      const meta: RunnerDescriptor = {
        id,
        role: info.role ?? (id === Runners.BACKEND ? 'backend' : 'frontend'),
        url: url ?? DEFAULT_WS_URL,
        language: info.language,
        capabilities: info.capabilities ?? [],
        projectRoot: info.projectRoot,
      };
      this.metas.set(id, meta);
      return meta;
    } catch {
      this.metas.delete(id);
      return null;
    }
  }

  conn(id: string): WsClient | undefined {
    return this.conns.get(id);
  }

  primary(): WsClient {
    return this.conns.get(Runners.BACKEND)!;
  }

  list(): RunnerDescriptor[] {
    return [...this.metas.values()];
  }

  /** Route a method to the runner that owns its capability. */
  forMethod(method: string): WsClient {
    if (method.startsWith('cdp.')) {
      const fe = this.list().find((m) => m.capabilities.includes('cdp'));
      if (fe) return this.conns.get(fe.id)!;
    }
    return this.primary();
  }
}

export const runners = new Runners();
