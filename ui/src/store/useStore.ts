import { create } from 'zustand';
import { call, ping } from '../rpc/client';
import { wsClient } from '../rpc/ws';
import type {
  FileModel,
  GutterMarker,
  InvokeResult,
  LedgerEntry,
  MarkerKind,
  Mode,
  Problem,
  RunResult,
  SwapSite,
  Transport,
  TreeModel,
  View,
} from '../types';

interface RunnerInfo {
  language: string;
  phpVersion: string;
  projectRoot: string;
  capabilities?: string[];
  host?: { driver: string; app: string } | null;
}

interface State {
  runner: RunnerInfo | null;
  connected: boolean;
  transport: Transport;
  hasHost: boolean;

  tree: TreeModel | null;
  openPath: string | null;
  source: string;
  structure: FileModel | null;
  problems: Problem[];

  mode: Mode;
  view: View;

  markers: GutterMarker[];
  swaps: SwapSite[];

  // Run / ledger
  entryMethod: string | null;
  entryArgs: string;
  ledger: LedgerEntry[];
  lastRun: RunResult | null;
  lastInvoke: { seq: number; result: InvokeResult } | null;
  browserSrc: string | null;
  log: string[];

  connect: () => Promise<void>;
  loadTree: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  toggleMarker: (line: number, kind: MarkerKind) => void;
  addSwap: (swap: SwapSite) => void;
  removeSwap: (path: string, line: number) => void;
  setView: (view: View) => void;
  setMode: (mode: Mode) => void;
  setEntryMethod: (m: string) => void;
  setEntryArgs: (a: string) => void;
  startRun: () => Promise<void>;
  replay: (seq: number, method: string) => Promise<void>;
  renderEntry: (method: string, uri: string) => Promise<void>;
}

// Transport router: prefer the WS host (full run capability), fall back to HTTP
// for static analysis when only bin/server.php is up.
async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (wsClient.status === 'open') return wsClient.call<T>(method, params);
  return call<T>(method, params);
}

export const useStore = create<State>((set, get) => ({
  runner: null,
  connected: false,
  transport: 'none',
  hasHost: false,
  tree: null,
  openPath: null,
  source: '',
  structure: null,
  problems: [],
  mode: 'idle',
  view: 'canvas',
  markers: [],
  swaps: [],
  entryMethod: null,
  entryArgs: '[]',
  ledger: [],
  lastRun: null,
  lastInvoke: null,
  browserSrc: null,
  log: [],

  connect: async () => {
    // Try the WS host first.
    const wsOk = await wsClient.connect();
    if (wsOk) {
      wsClient.onNotification((method, params) => {
        if (method === 'ledger.captured') {
          set({ ledger: [...get().ledger, params as unknown as LedgerEntry] });
          get().log.push(`captured ${(params as { id: string }).id}`);
        }
      });
      const info = await wsClient.call<RunnerInfo>('runner.info');
      set({
        runner: info,
        connected: true,
        transport: 'ws',
        hasHost: (info.capabilities ?? []).includes('run'),
      });
      return;
    }
    // Fall back to HTTP (static analysis only).
    const info = await ping();
    set({
      runner: info as RunnerInfo | null,
      connected: info !== null,
      transport: info !== null ? 'http' : 'none',
      hasHost: false,
    });
  },

  loadTree: async () => {
    const tree = await rpc<TreeModel>('structure.tree', { root: '.' });
    set({ tree });
  },

  openFile: async (path: string) => {
    const [{ source }, structure, { problems }] = await Promise.all([
      rpc<{ source: string }>('fs.read', { path }),
      rpc<FileModel>('structure.file', { path }),
      rpc<{ problems: Problem[] }>('swap.scan', { path }),
    ]);
    // Default the entry to the first public method of the first class.
    let entryMethod: string | null = null;
    for (const node of structure.nodes) {
      if (node.kind === 'function') continue;
      const pub = node.members.find((m) => m.kind === 'method' && m.visibility === 'public');
      if (pub) {
        entryMethod = pub.name;
        break;
      }
    }
    set({ openPath: path, source, structure, problems, view: 'code', entryMethod });
  },

  toggleMarker: (line, kind) => {
    const { markers, openPath } = get();
    if (!openPath) return;
    const existing = markers.find((m) => m.path === openPath && m.line === line && m.kind === kind);
    if (existing) {
      set({ markers: markers.filter((m) => m !== existing) });
    } else {
      const cleaned = markers.filter((m) => !(m.path === openPath && m.line === line));
      set({ markers: [...cleaned, { path: openPath, line, kind }] });
    }
  },

  addSwap: (swap) => {
    const swaps = get().swaps.filter((s) => !(s.path === swap.path && s.line === swap.line));
    set({ swaps: [...swaps, swap] });
  },

  removeSwap: (path, line) => {
    set({ swaps: get().swaps.filter((s) => !(s.path === path && s.line === line)) });
  },

  setView: (view) => set({ view }),
  setMode: (mode) => set({ mode }),
  setEntryMethod: (entryMethod) => set({ entryMethod }),
  setEntryArgs: (entryArgs) => set({ entryArgs }),

  startRun: async () => {
    const { openPath, structure, entryMethod, entryArgs, markers, swaps } = get();
    if (!openPath || !structure || !entryMethod) return;

    const firstClass = structure.nodes.find((n) => n.kind !== 'function');
    if (!firstClass || firstClass.kind === 'function') return;

    let args: unknown[] = [];
    try {
      args = JSON.parse(entryArgs);
      if (!Array.isArray(args)) args = [args];
    } catch {
      set({ lastRun: { ok: false, error: 'entry args must be valid JSON array' } });
      return;
    }

    const waypoints = markers
      .filter((m) => m.path === openPath && m.kind === 'waypoint')
      .map((m) => ({ line: m.line }));
    const fileSwaps = swaps
      .filter((s) => s.path === openPath)
      .map((s) => ({ line: s.line, mode: 'replace', expression: s.expression }));

    set({ mode: 'running', ledger: [], log: [...get().log, `run ${(firstClass as { name: string }).name}::${entryMethod}`] });

    try {
      const run = await rpc<RunResult>('run.slice', {
        path: openPath,
        class: (firstClass as { name: string }).name,
        method: entryMethod,
        args,
        waypoints,
        swaps: fileSwaps,
      });
      set({ lastRun: run, ledger: run.ledger ?? get().ledger });
    } catch (e) {
      set({ lastRun: { ok: false, error: (e as Error).message } });
    }
  },

  replay: async (seq, method) => {
    try {
      const result = await rpc<InvokeResult>('run.invoke', { seq, method, mode: 'peek' });
      set({ lastInvoke: { seq, result } });
    } catch (e) {
      set({ lastInvoke: { seq, result: { ok: false, error: (e as Error).message, mode: 'peek', committed: false, reproducible: false } } });
    }
  },

  renderEntry: async (method, uri) => {
    if (!get().hasHost) return;
    const res = await rpc<{ body: string }>('host.entry', { method, uri });
    set({ browserSrc: res.body });
  },
}));
