import { create } from 'zustand';
import { call, ping } from '../rpc/client';
import { wsClient } from '../rpc/ws';
import type {
  BreakpointHit,
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
  canvasMode: 'flat' | 'tree';
  collapsedGroups: string[];
  expandedClasses: string[];
  revealLine: number | null;

  markers: GutterMarker[];
  swaps: SwapSite[];

  // Run / ledger
  runMode: 'unit' | 'request';
  reqMethod: string;
  reqUri: string;
  entryMethod: string | null;
  entryArgs: string;
  ledger: LedgerEntry[];
  breakpointHits: BreakpointHit[];
  lastRun: RunResult | null;
  lastInvoke: { seq: number; result: InvokeResult } | null;
  browserSrc: string | null;
  log: string[];

  connect: () => Promise<void>;
  loadTree: () => Promise<void>;
  openProject: (root: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  toggleMarker: (line: number, kind: MarkerKind) => void;
  addSwap: (swap: SwapSite) => void;
  removeSwap: (path: string, line: number) => void;
  setView: (view: View) => void;
  setMode: (mode: Mode) => void;
  setCanvasMode: (m: 'flat' | 'tree') => void;
  toggleGroup: (id: string) => void;
  toggleClass: (id: string) => void;
  revealMember: (path: string, line: number) => Promise<void>;
  clearReveal: () => void;
  setEntryMethod: (m: string) => void;
  setEntryArgs: (a: string) => void;
  setRunMode: (m: 'unit' | 'request') => void;
  setReqMethod: (m: string) => void;
  setReqUri: (u: string) => void;
  startRun: () => Promise<void>;
  startRequest: () => Promise<void>;
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
  canvasMode: 'tree',
  collapsedGroups: [],
  expandedClasses: [],
  revealLine: null,
  markers: [],
  swaps: [],
  runMode: 'unit',
  reqMethod: 'GET',
  reqUri: '/',
  entryMethod: null,
  entryArgs: '[]',
  ledger: [],
  breakpointHits: [],
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
        } else if (method === 'breakpoint.hit') {
          set({ breakpointHits: [...get().breakpointHits, params as unknown as BreakpointHit] });
          get().log.push(`breakpoint ${(params as { id: string }).id}`);
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

  openProject: async (root: string) => {
    const res = await rpc<{ ok: boolean; projectRoot: string; host?: { driver: string; app: string } }>('project.open', { root });
    if (!res.ok) return;
    const info = await rpc<RunnerInfo>('runner.info');
    set({
      runner: info,
      hasHost: (info.capabilities ?? []).includes('run'),
      // reset the workspace for the new project
      openPath: null,
      source: '',
      structure: null,
      problems: [],
      markers: [],
      swaps: [],
      ledger: [],
      breakpointHits: [],
      lastRun: null,
      lastInvoke: null,
      browserSrc: null,
      collapsedGroups: [],
      expandedClasses: [],
      mode: 'idle',
    });
    await get().loadTree();
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
  setCanvasMode: (canvasMode) => set({ canvasMode }),
  toggleGroup: (id) => {
    const c = get().collapsedGroups;
    set({ collapsedGroups: c.includes(id) ? c.filter((x) => x !== id) : [...c, id] });
  },
  toggleClass: (id) => {
    const e = get().expandedClasses;
    set({ expandedClasses: e.includes(id) ? e.filter((x) => x !== id) : [...e, id] });
  },
  revealMember: async (path, line) => {
    if (get().openPath !== path) await get().openFile(path);
    set({ view: 'code', revealLine: line });
  },
  clearReveal: () => set({ revealLine: null }),
  setEntryMethod: (entryMethod) => set({ entryMethod }),
  setEntryArgs: (entryArgs) => set({ entryArgs }),
  setRunMode: (runMode) => set({ runMode }),
  setReqMethod: (reqMethod) => set({ reqMethod }),
  setReqUri: (reqUri) => set({ reqUri }),

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
    const breakpoints = markers
      .filter((m) => m.path === openPath && m.kind === 'breakpoint')
      .map((m) => ({ line: m.line }));
    const fileSwaps = swaps
      .filter((s) => s.path === openPath)
      .map((s) => ({ line: s.line, mode: 'replace', expression: s.expression }));

    set({ mode: 'running', ledger: [], breakpointHits: [], log: [...get().log, `run ${(firstClass as { name: string }).name}::${entryMethod}`] });

    try {
      const run = await rpc<RunResult>('run.slice', {
        path: openPath,
        class: (firstClass as { name: string }).name,
        method: entryMethod,
        args,
        waypoints,
        breakpoints,
        breakpointMode: 'halt',
        swaps: fileSwaps,
      });
      set({ lastRun: run, ledger: run.ledger ?? get().ledger });
    } catch (e) {
      set({ lastRun: { ok: false, error: (e as Error).message } });
    }
  },

  startRequest: async () => {
    const { markers, swaps, reqMethod, reqUri } = get();

    // Cross-file targets: every waypoint marker, grouped by file. This is the
    // whole-request capability — capture flows through every targeted class the
    // request touches, not one unit.
    type Target = { waypoints: { line: number }[]; swaps: { line: number; mode: string; expression?: string }[]; breakpoints: { line: number }[] };
    const targets: Record<string, Target> = {};
    const ensure = (p: string): Target => (targets[p] ??= { waypoints: [], swaps: [], breakpoints: [] });
    for (const m of markers.filter((mk) => mk.kind === 'waypoint')) ensure(m.path).waypoints.push({ line: m.line });
    for (const m of markers.filter((mk) => mk.kind === 'breakpoint')) ensure(m.path).breakpoints.push({ line: m.line });
    for (const s of swaps) ensure(s.path).swaps.push({ line: s.line, mode: 'replace', expression: s.expression });

    if (Object.keys(targets).length === 0) {
      set({ lastRun: { ok: false, error: 'place at least one waypoint or breakpoint before running a request' } });
      return;
    }

    set({ mode: 'running', ledger: [], breakpointHits: [], log: [...get().log, `request ${reqMethod} ${reqUri}`] });

    try {
      const run = await rpc<RunResult & { response?: { body?: string } }>('run.request', {
        targets,
        entry: { kind: 'http', method: reqMethod, uri: reqUri },
      });
      set({
        lastRun: run,
        ledger: run.ledger ?? get().ledger,
        browserSrc: run.response?.body ?? get().browserSrc,
      });
    } catch (e) {
      set({ lastRun: { ok: false, error: (e as Error).message } });
    }
  },

  replay: async (seq, method) => {
    // Whole-request entries carry a reconstruction blob (their subprocess has
    // exited) — pass the full entry. Unit-run entries live in the resident
    // ledger — replay by seq.
    const entry = get().ledger.find((e) => e.seq === seq);
    const params = entry?.receiver?.blob ? { entry, method, mode: 'peek' } : { seq, method, mode: 'peek' };
    try {
      const result = await rpc<InvokeResult>('run.invoke', params);
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
