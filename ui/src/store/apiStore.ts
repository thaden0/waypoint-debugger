import { create } from 'zustand';
import { call } from '../rpc/client';
import { wsClient } from '../rpc/ws';
import { useStore } from './useStore';
import type { BreakpointHit, LedgerEntry } from '../types';

// The project-aware API console — Postman fused with the replay debugger. Routes
// come from the booted host (api.routes); an in-process send runs through the
// instrumented kernel (capture for free, lands in the main ledger so the replay
// what-if loop works on it); an external send is a plain server-side HTTP call.
// Saved requests + environments persist to .waypoint/api.json (api.collection.*).

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (wsClient.status === 'open') return wsClient.call<T>(method, params);
  return call<T>(method, params);
}

export interface ApiRoute {
  methods: string[];
  uri: string;
  name: string | null;
  action: string;
  middleware: string[];
  params: string[];
}

export interface KV {
  key: string;
  value: string;
  on: boolean;
}

export type Target = 'inprocess' | 'external';
export type BodyMode = 'none' | 'json' | 'raw' | 'form';
export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey';

export interface ApiAuth {
  type: AuthType;
  token: string;
  username: string;
  password: string;
  key: string;
  value: string;
  addTo: 'header' | 'query';
}

export interface ApiRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  target: Target;
  query: KV[];
  headers: KV[];
  bodyMode: BodyMode;
  bodyRaw: string;
  bodyForm: KV[];
  auth: ApiAuth;
  preScript?: string;
  testScript?: string;
}

export interface ApiEnv {
  name: string;
  vars: KV[];
}

export interface ApiResponse {
  ok: boolean;
  status?: number;
  durationMs?: number;
  size?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  error?: string;
  captured?: boolean;
  ledgerCount?: number;
  tests?: TestResult[];
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ApiHistory {
  id: string;
  method: string;
  url: string;
  target: Target;
  status?: number;
  ok: boolean;
  durationMs?: number;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

let seq = 0;
const uid = (p: string): string => `${p}_${++seq}`;

function emptyAuth(): ApiAuth {
  return { type: 'none', token: '', username: '', password: '', key: '', value: '', addTo: 'header' };
}

function blankRequest(): ApiRequest {
  return {
    id: uid('req'),
    name: 'Untitled request',
    method: 'GET',
    url: '/',
    target: 'inprocess',
    query: [],
    headers: [],
    bodyMode: 'none',
    bodyRaw: '',
    bodyForm: [],
    auth: emptyAuth(),
    preScript: '',
    testScript: '',
  };
}

function routeToRequest(r: ApiRoute): ApiRequest {
  // Fill path params with {{param}} placeholders so they're obvious and editable.
  let url = r.uri;
  for (const p of r.params) url = url.replace(`{${p}}`, `{{${p}}}`).replace(`{${p}?}`, `{{${p}}}`);
  const method = r.methods.find((m) => m !== 'HEAD') ?? 'GET';
  return {
    ...blankRequest(),
    id: uid('req'),
    name: r.name ?? `${method} ${r.uri}`,
    method,
    url,
    bodyMode: method === 'GET' || method === 'DELETE' ? 'none' : 'json',
  };
}

interface ApiState {
  loaded: boolean;
  routes: ApiRoute[];
  saved: ApiRequest[];
  environments: ApiEnv[];
  activeEnv: string | null;
  draft: ApiRequest;
  response: ApiResponse | null;
  sending: boolean;
  history: ApiHistory[];
  collectionTab: 'routes' | 'saved';

  load: () => Promise<void>;
  patchDraft: (p: Partial<ApiRequest>) => void;
  setDraft: (r: ApiRequest) => void;
  loadRoute: (r: ApiRoute) => void;
  loadSaved: (r: ApiRequest) => void;
  newRequest: () => void;
  setCollectionTab: (t: 'routes' | 'saved') => void;
  send: () => Promise<void>;
  saveDraft: () => Promise<void>;
  deleteSaved: (id: string) => Promise<void>;
  setActiveEnv: (name: string | null) => void;
  addEnv: (name: string) => void;
  setEnvVars: (name: string, vars: KV[]) => void;
}

// Resolve {{var}} against the active environment.
function resolver(envs: ApiEnv[], active: string | null): (s: string) => string {
  const env = envs.find((e) => e.name === active);
  const map = new Map<string, string>();
  for (const v of env?.vars ?? []) if (v.on && v.key) map.set(v.key, v.value);
  return (s: string) => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => (map.has(k) ? map.get(k)! : m));
}

const onKV = (kvs: KV[], resolve: (s: string) => string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const kv of kvs) if (kv.on && kv.key) out[resolve(kv.key)] = resolve(kv.value);
  return out;
};

export const useApiStore = create<ApiState>((set, get) => ({
  loaded: false,
  routes: [],
  saved: [],
  environments: [],
  activeEnv: null,
  draft: blankRequest(),
  response: null,
  sending: false,
  history: [],
  collectionTab: 'routes',

  load: async () => {
    try {
      const [{ routes }, { collection }] = await Promise.all([
        rpc<{ routes: ApiRoute[] }>('api.routes'),
        rpc<{ collection: { requests: ApiRequest[]; environments: ApiEnv[]; activeEnv: string | null } }>('api.collection.load'),
      ]);
      const environments = collection.environments?.length ? collection.environments : [{ name: 'local', vars: [{ key: 'base', value: 'http://localhost:8000', on: true }] }];
      set({
        loaded: true,
        routes,
        saved: collection.requests ?? [],
        environments,
        activeEnv: collection.activeEnv ?? environments[0]?.name ?? null,
        collectionTab: routes.length ? 'routes' : 'saved',
      });
    } catch (e) {
      set({ loaded: true, response: { ok: false, error: `load failed: ${(e as Error).message}` } });
    }
  },

  patchDraft: (p) => set({ draft: { ...get().draft, ...p } }),
  setDraft: (r) => set({ draft: r }),
  loadRoute: (r) => set({ draft: routeToRequest(r), response: null }),
  loadSaved: (r) => set({ draft: structuredClone(r), response: null }),
  newRequest: () => set({ draft: blankRequest(), response: null }),
  setCollectionTab: (t) => set({ collectionTab: t }),

  send: async () => {
    const { draft, environments, activeEnv } = get();
    const resolve = resolver(environments, activeEnv);
    set({ sending: true, response: null });

    // Build headers (incl. auth) + body + content-type.
    const headers = onKV(draft.headers, resolve);
    const query = onKV(draft.query, resolve);
    let body: string | undefined;
    let contentType: string | undefined;
    if (draft.bodyMode === 'json') {
      body = resolve(draft.bodyRaw);
      contentType = 'application/json';
    } else if (draft.bodyMode === 'raw') {
      body = resolve(draft.bodyRaw);
    } else if (draft.bodyMode === 'form') {
      body = new URLSearchParams(onKV(draft.bodyForm, resolve)).toString();
      contentType = 'application/x-www-form-urlencoded';
    }
    if (contentType && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = contentType;
    }
    applyAuth(draft.auth, resolve, headers, query);

    let url = resolve(draft.url);
    const params: Record<string, unknown> = { method: draft.method, query, headers, body, contentType };

    if (draft.target === 'external') {
      // External needs an absolute URL; prepend env `base` for a bare path.
      if (!/^https?:\/\//i.test(url)) {
        const base = (environments.find((e) => e.name === activeEnv)?.vars.find((v) => v.key === 'base' && v.on)?.value ?? '').replace(/\/$/, '');
        url = base + (url.startsWith('/') ? url : '/' + url);
      }
      params.target = 'external';
      params.url = url;
    } else {
      // In-process: strip any origin to a path; build capture targets from markers.
      params.target = 'inprocess';
      params.uri = url.replace(/^https?:\/\/[^/]+/i, '') || '/';
      params.targets = buildTargets();
      useStore.setState({ ledger: [], breakpointHits: [] });
    }

    const started = performance.now();
    try {
      const res = await rpc<{ ok: boolean; captured?: boolean; response?: ApiResponse; error?: string; ledger?: LedgerEntry[]; breakpoints?: BreakpointHit[] }>('api.send', params);
      const r = res.response;
      const elapsed = Math.round(performance.now() - started);
      const response: ApiResponse = res.ok && r
        ? { ok: true, status: r.status, durationMs: r.durationMs ?? elapsed, size: (r.body ?? '').length, body: r.body, contentType: r.contentType, headers: r.headers, captured: res.captured, ledgerCount: res.ledger?.length ?? 0 }
        : { ok: false, error: res.error ?? 'request failed', captured: res.captured };
      // Push captured entries into the main ledger so they're replayable.
      if (res.captured && res.ledger) {
        useStore.setState({ ledger: res.ledger, breakpointHits: res.breakpoints ?? [] });
      }
      set((s) => ({
        response,
        sending: false,
        history: [{ id: uid('h'), method: draft.method, url, target: draft.target, status: response.status, ok: response.ok, durationMs: response.durationMs }, ...s.history].slice(0, 50),
      }));
    } catch (e) {
      set({ response: { ok: false, error: (e as Error).message }, sending: false });
    }
  },

  saveDraft: async () => {
    const { draft, saved } = get();
    const next = saved.some((r) => r.id === draft.id)
      ? saved.map((r) => (r.id === draft.id ? draft : r))
      : [...saved, draft];
    set({ saved: next });
    await persist(get);
  },

  deleteSaved: async (id) => {
    set({ saved: get().saved.filter((r) => r.id !== id) });
    await persist(get);
  },

  setActiveEnv: (name) => {
    set({ activeEnv: name });
    void persist(get);
  },
  addEnv: (name) => {
    if (!name || get().environments.some((e) => e.name === name)) return;
    set({ environments: [...get().environments, { name, vars: [] }], activeEnv: name });
    void persist(get);
  },
  setEnvVars: (name, vars) => {
    set({ environments: get().environments.map((e) => (e.name === name ? { ...e, vars } : e)) });
    void persist(get);
  },
}));

function applyAuth(auth: ApiAuth, resolve: (s: string) => string, headers: Record<string, string>, query: Record<string, string>): void {
  if (auth.type === 'bearer' && auth.token) {
    headers['Authorization'] = `Bearer ${resolve(auth.token)}`;
  } else if (auth.type === 'basic') {
    headers['Authorization'] = `Basic ${btoa(`${resolve(auth.username)}:${resolve(auth.password)}`)}`;
  } else if (auth.type === 'apikey' && auth.key) {
    if (auth.addTo === 'query') query[resolve(auth.key)] = resolve(auth.value);
    else headers[resolve(auth.key)] = resolve(auth.value);
  }
}

// Capture targets from the editor markers/swaps — the same shape run.request uses,
// so an in-process send fires whatever waypoints/breakpoints are placed.
function buildTargets(): Record<string, { waypoints: { line: number }[]; swaps: { line: number; mode: string; expression?: string }[]; breakpoints: { line: number }[] }> {
  const { markers, swaps } = useStore.getState();
  const targets: Record<string, { waypoints: { line: number }[]; swaps: { line: number; mode: string; expression?: string }[]; breakpoints: { line: number }[] }> = {};
  const ensure = (p: string) => (targets[p] ??= { waypoints: [], swaps: [], breakpoints: [] });
  for (const m of markers.filter((mk) => mk.kind === 'waypoint')) ensure(m.path).waypoints.push({ line: m.line });
  for (const m of markers.filter((mk) => mk.kind === 'breakpoint')) ensure(m.path).breakpoints.push({ line: m.line });
  for (const s of swaps) ensure(s.path).swaps.push({ line: s.line, mode: 'replace', expression: s.expression });
  return targets;
}

async function persist(get: () => ApiState): Promise<void> {
  const { saved, environments, activeEnv } = get();
  try {
    await rpc('api.collection.save', { collection: { requests: saved, environments, activeEnv } });
  } catch {
    // Non-fatal: persistence is best-effort (e.g. read-only project).
  }
}

export { METHODS };
