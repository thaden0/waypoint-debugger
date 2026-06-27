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

// The replay what-if loop: one captured checkpoint, reconstructed, re-invokable
// with edited inputs. `baseline` is the as-captured outcome (always peek); the
// user edits tier-1 args / picks a method / chooses mode, re-invokes, and we diff
// `result` against `baseline`.
export interface ArgEdit {
  type: string;
  tier: 1 | 2 | 3;
  editable: boolean; // tier-1 scalar/array → authorable; tier 2/3 kept as captured
  original: string; // JSON text of the captured value
  text: string; // current (possibly edited) JSON text
  error?: string; // JSON parse error, if any
}

export interface Experiment {
  seq: number;
  entryId: string;
  defaultMethod: string;
  method: string; // method to re-enter on the reconstructed receiver
  mode: 'peek' | 'destructive';
  args: ArgEdit[];
  baseline: InvokeResult | null; // as-captured, peek
  result: InvokeResult | null; // latest what-if outcome
  running: boolean;
}

interface State {
  runner: RunnerInfo | null;
  connected: boolean;
  transport: Transport;
  hasHost: boolean;

  tree: TreeModel | null;
  openPath: string | null;
  source: string;
  savedSource: string; // last-persisted content; source !== savedSource => dirty
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
  lastRunParams: Record<string, unknown> | null;
  lastRun: RunResult | null;

  // Interactive debug session (true pause/resume)
  debugActive: boolean;
  debugPaused: { id: string; line: number; scope: Record<string, { tier: number; type: string; preview: unknown }> } | null;
  debugResult: { ok: boolean; result?: unknown; stopped?: boolean } | null;
  currentLine: number | null;
  experiment: Experiment | null;
  settingsOpen: boolean;
  modules: ModulesAvailable | null;
  projectConfig: ProjectConfigShape | null;
  savingSettings: boolean;
  browserSrc: string | null;
  log: string[];

  connect: () => Promise<void>;
  loadTree: () => Promise<void>;
  openProject: (root: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  setEditedSource: (source: string) => void;
  saveFile: () => Promise<void>;
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
  startDebug: () => Promise<void>;
  debugCommand: (cmd: 'continue' | 'step' | 'stop') => Promise<void>;
  continueWithOverrides: (line: number, overrides: Array<{ var: string; expression: string }>) => Promise<void>;
  openExperiment: (seq: number) => Promise<void>;
  closeExperiment: () => void;
  setExpArg: (index: number, text: string) => void;
  setExpMethod: (method: string) => void;
  setExpMode: (mode: 'peek' | 'destructive') => void;
  runExperiment: () => Promise<void>;
  renderEntry: (method: string, uri: string) => Promise<void>;
  openSettings: () => Promise<void>;
  closeSettings: () => void;
  saveSettings: (config: ProjectConfigShape) => Promise<void>;
  refreshRunner: () => Promise<void>;
}

export interface ModulesAvailable {
  modules: { id: string; detect: string[]; role: string; capabilities: string[] }[];
  languages: { id: string; role: string; extensions: string[]; monaco: string | null }[];
  providers: Record<string, { id: string; framework: string }[]>;
  detected: string | null;
  active: string | null;
}
export interface ProjectConfigShape {
  module: string | null;
  providers: { orm: string | null; routes: string | null };
}

// Transport router: prefer the WS host (full run capability), fall back to HTTP
// for static analysis when only bin/server.php is up.
async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (wsClient.status === 'open') return wsClient.call<T>(method, params);
  return call<T>(method, params);
}

// Reconstruct + invoke one checkpoint. Whole-request entries carry a base64
// reconstruction blob (their subprocess has exited) — pass the full entry;
// unit-run entries live in the resident ledger and are keyed by seq.
async function invokeEntry(
  ledger: LedgerEntry[],
  seq: number,
  method: string,
  mode: 'peek' | 'destructive',
  argOverrides: Record<number, unknown> | null,
): Promise<InvokeResult> {
  const entry = ledger.find((e) => e.seq === seq);
  const base = entry?.receiver?.blob ? { entry } : { seq };
  const params = { ...base, method, mode, ...(argOverrides ? { argOverrides } : {}) };
  try {
    return await rpc<InvokeResult>('run.invoke', params);
  } catch (e) {
    return { ok: false, error: (e as Error).message, mode, committed: false, reproducible: false };
  }
}

// Subscribe to server notifications exactly once, even though connect() may run
// several times (StrictMode double-mount + the retry loop).
let notificationsBound = false;

export const useStore = create<State>((set, get) => ({
  runner: null,
  connected: false,
  transport: 'none',
  hasHost: false,
  tree: null,
  openPath: null,
  source: '',
  savedSource: '',
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
  lastRunParams: null,
  lastRun: null,
  debugActive: false,
  debugPaused: null,
  debugResult: null,
  currentLine: null,
  experiment: null,
  settingsOpen: false,
  modules: null,
  projectConfig: null,
  savingSettings: false,
  browserSrc: null,
  log: [],

  connect: async () => {
    // Try the WS host first.
    const wsOk = await wsClient.connect();
    if (wsOk) {
      if (!notificationsBound) {
        notificationsBound = true;
        wsClient.onNotification((method, params) => {
        if (method === 'ledger.captured') {
          set({ ledger: [...get().ledger, params as unknown as LedgerEntry] });
          get().log.push(`captured ${(params as { id: string }).id}`);
        } else if (method === 'breakpoint.hit') {
          set({ breakpointHits: [...get().breakpointHits, params as unknown as BreakpointHit] });
          get().log.push(`breakpoint ${(params as { id: string }).id}`);
        } else if (method === 'debug.paused') {
          const p = params as { id: string; line: number; scope: Record<string, { tier: number; type: string; preview: unknown }> };
          set({ debugPaused: p, currentLine: p.line, revealLine: p.line });
          get().log.push(`paused @ line ${p.line}`);
        } else if (method === 'debug.finished') {
          const p = params as { ok: boolean; result?: unknown; stopped?: boolean };
          set({ debugActive: false, debugPaused: null, currentLine: null, debugResult: p });
          get().log.push(`debug finished${p.stopped ? ' (stopped)' : ''}`);
        }
        });
      }
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
      experiment: null,
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
    set({ openPath: path, source, savedSource: source, structure, problems, view: 'code', entryMethod });
  },

  setEditedSource: (source) => set({ source }),

  // Persist the editor content, then re-derive structure + problems from the
  // saved source (line-based markers/eligibility track the new code).
  saveFile: async () => {
    const { openPath, source } = get();
    if (!openPath) return;
    await rpc('fs.write', { path: openPath, source });
    const [structure, { problems }] = await Promise.all([
      rpc<FileModel>('structure.file', { path: openPath, source }),
      rpc<{ problems: Problem[] }>('swap.scan', { path: openPath, source }),
    ]);
    set({ savedSource: source, structure, problems, log: [...get().log, `saved ${openPath}`] });
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

    const params = {
      path: openPath,
      source: get().source, // run the live editor content (test edits before saving)
      class: (firstClass as { name: string }).name,
      method: entryMethod,
      args,
      waypoints,
      breakpoints,
      breakpointMode: 'halt',
      swaps: fileSwaps,
    };
    set({
      mode: 'running',
      ledger: [],
      breakpointHits: [],
      lastRunParams: params,
      log: [...get().log, `run ${(firstClass as { name: string }).name}::${entryMethod}`],
    });

    try {
      const run = await rpc<RunResult>('run.slice', params);
      set({ lastRun: run, ledger: run.ledger ?? get().ledger });
    } catch (e) {
      set({ lastRun: { ok: false, error: (e as Error).message } });
    }
  },

  // Interactive debug session — true pause/resume across a subprocess.
  startDebug: async () => {
    const { openPath, structure, entryMethod, entryArgs, markers, swaps } = get();
    if (!openPath || !structure || !entryMethod) return;
    const firstClass = structure.nodes.find((n) => n.kind !== 'function');
    if (!firstClass || firstClass.kind === 'function') return;

    let args: unknown[] = [];
    try {
      args = JSON.parse(entryArgs);
      if (!Array.isArray(args)) args = [args];
    } catch {
      set({ debugResult: { ok: false } });
      return;
    }
    const breakpoints = markers.filter((m) => m.path === openPath && m.kind === 'breakpoint').map((m) => ({ line: m.line }));
    const fileSwaps = swaps.filter((s) => s.path === openPath).map((s) => ({ line: s.line, mode: 'replace', expression: s.expression }));

    set({ mode: 'running', debugActive: true, debugPaused: null, debugResult: null, currentLine: null, log: [...get().log, `debug ${(firstClass as { name: string }).name}::${entryMethod}`] });
    try {
      await rpc('run.debug.start', {
        path: openPath,
        source: get().source,
        class: (firstClass as { name: string }).name,
        method: entryMethod,
        args,
        breakpoints,
        swaps: fileSwaps,
      });
    } catch (e) {
      set({ debugActive: false, debugResult: { ok: false }, log: [...get().log, `debug error: ${(e as Error).message}`] });
    }
  },

  debugCommand: async (cmd) => {
    // optimistic: clear the paused state until the next pause arrives
    if (cmd === 'stop') set({ debugActive: false, debugPaused: null, currentLine: null });
    else set({ debugPaused: null, currentLine: null });
    try {
      await rpc(`run.debug.${cmd}`);
    } catch {
      /* session may have ended */
    }
  },

  // "Change a variable on the fly": re-run the same unit slice with the edited
  // values injected at the breakpoint line, and run to completion (no halt).
  continueWithOverrides: async (line, overrides) => {
    const base = get().lastRunParams;
    if (!base) return;
    set({ log: [...get().log, `continue with ${overrides.length} override(s)`] });
    try {
      const run = await rpc<RunResult>('run.slice', {
        ...base,
        waypoints: [],
        breakpoints: [],
        overrides: overrides.map((o) => ({ line, var: o.var, expression: o.expression })),
      });
      set({ lastRun: run });
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

  // Open (or toggle closed) the what-if panel for a checkpoint. On open we build
  // the editable arg set from the captured snapshots and immediately run the
  // baseline (as-captured, peek) so the diff has something to compare against.
  openExperiment: async (seq) => {
    if (get().experiment?.seq === seq) {
      set({ experiment: null });
      return;
    }
    const entry = get().ledger.find((e) => e.seq === seq);
    if (!entry) return;
    const method = entry.id.split('::')[1] ?? entry.id;
    const args: ArgEdit[] = entry.args.map((a) => {
      const editable = a.tier === 1;
      const original = JSON.stringify(a.preview ?? null);
      return { type: a.type, tier: a.tier, editable, original, text: original };
    });
    set({
      experiment: {
        seq,
        entryId: entry.id,
        defaultMethod: method,
        method,
        mode: 'peek',
        args,
        baseline: null,
        result: null,
        running: true,
      },
    });
    const baseline = await invokeEntry(get().ledger, seq, method, 'peek', null);
    const exp = get().experiment;
    if (exp?.seq === seq) set({ experiment: { ...exp, baseline, running: false } });
  },

  closeExperiment: () => set({ experiment: null }),

  setExpArg: (index, text) => {
    const exp = get().experiment;
    if (!exp) return;
    const args = exp.args.map((a, i) => (i === index ? { ...a, text, error: undefined } : a));
    set({ experiment: { ...exp, args } });
  },

  setExpMethod: (method) => {
    const exp = get().experiment;
    if (exp) set({ experiment: { ...exp, method } });
  },

  setExpMode: (mode) => {
    const exp = get().experiment;
    if (exp) set({ experiment: { ...exp, mode } });
  },

  // Run the what-if: parse the edited args, build the override map (only the args
  // the user actually changed), and re-invoke. A bad JSON arg fails fast with an
  // inline error rather than hitting the runner.
  runExperiment: async () => {
    const exp = get().experiment;
    if (!exp) return;
    const argOverrides: Record<number, unknown> = {};
    const args = [...exp.args];
    let bad = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.editable || a.text === a.original) continue;
      try {
        argOverrides[i] = JSON.parse(a.text);
      } catch {
        args[i] = { ...a, error: 'invalid JSON' };
        bad = true;
      }
    }
    if (bad) {
      set({ experiment: { ...exp, args } });
      return;
    }
    set({ experiment: { ...exp, running: true } });
    const result = await invokeEntry(
      get().ledger,
      exp.seq,
      exp.method,
      exp.mode,
      Object.keys(argOverrides).length ? argOverrides : null,
    );
    const cur = get().experiment;
    if (cur?.seq === exp.seq) set({ experiment: { ...cur, result, running: false } });
  },

  renderEntry: async (method, uri) => {
    if (!get().hasHost) return;
    const res = await rpc<{ body: string }>('host.entry', { method, uri });
    set({ browserSrc: res.body });
  },

  openSettings: async () => {
    set({ settingsOpen: true });
    try {
      const [modules, cfg] = await Promise.all([
        rpc<ModulesAvailable>('modules.available'),
        rpc<{ config: ProjectConfigShape }>('project.config.get'),
      ]);
      set({ modules, projectConfig: cfg.config });
    } catch (e) {
      get().log.push(`settings load failed: ${(e as Error).message}`);
    }
  },

  closeSettings: () => set({ settingsOpen: false }),

  saveSettings: async (config) => {
    set({ savingSettings: true });
    try {
      const res = await rpc<{ ok: boolean; active: string | null; config: ProjectConfigShape }>('project.config.save', { config });
      set((s) => ({ projectConfig: res.config, modules: s.modules ? { ...s.modules, active: res.active } : s.modules }));
      await get().refreshRunner(); // capabilities may have changed (e.g. orm)
    } finally {
      set({ savingSettings: false });
    }
  },

  refreshRunner: async () => {
    try {
      const info = await rpc<RunnerInfo>('runner.info');
      set({ runner: info, hasHost: (info.capabilities ?? []).includes('host') });
    } catch {
      // leave existing runner info in place
    }
  },
}));

// Dev-only handle: lets you poke the live store from the console (and drives
// end-to-end UI checks). Stripped from production behaviour by the DEV guard.
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __wpStore?: typeof useStore }).__wpStore = useStore;
}
