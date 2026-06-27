import { create } from 'zustand';
import { call } from '../rpc/client';
import { wsClient } from '../rpc/ws';
import { useStore } from './useStore';
import type { BreakpointHit, LedgerEntry } from '../types';

// ORM data console: work with the project's data through its own Eloquent models,
// evaluated in the booted host. A query is real PHP (transaction-guarded: peek
// rolls back, commit persists). Mirrors the API console's shape.

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (wsClient.status === 'open') return wsClient.call<T>(method, params);
  return call<T>(method, params);
}

export interface ModelInfo {
  name: string;
  class: string;
  path: string;
  table: string;
  count: number | null;
}
export interface Column {
  name: string;
  type: string;
}
export interface Relationship {
  method: string;
  type: string;
  related: string | null;
}
export interface SqlLine {
  query: string;
  bindings: unknown[];
  time: number | null;
}
export interface QueryOutcome {
  ok: boolean;
  type?: string;
  result?: unknown;
  count?: number | null;
  sql?: SqlLine[];
  committed?: boolean;
  error?: string;
  durationMs?: number;
}
export interface ConsoleEntry extends QueryOutcome {
  expr: string;
}
export type ContentTab = 'grid' | 'source' | 'relationships' | 'alter';

interface TableState {
  columns: Column[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  perPage: number;
  loading: boolean;
  error?: string;
}

interface AlterForm {
  table: string;
  fillable: string; // newline/comma separated in the form
  casts: string; // "key: type" per line
  saving: boolean;
  saved?: boolean;
  error?: string;
}

interface OrmState {
  loaded: boolean;
  models: ModelInfo[];
  selected: string | null;
  search: string;
  contentTab: ContentTab;

  table: TableState;
  source: string;
  relationships: Relationship[];
  alter: AlterForm;

  consoleInput: string;
  consoleLog: ConsoleEntry[];
  commit: boolean;
  running: boolean;

  migrateOutput: string | null;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  select: (name: string) => Promise<void>;
  setContentTab: (t: ContentTab) => void;
  setSearch: (s: string) => void;
  loadTable: (page?: number) => Promise<void>;
  setConsoleInput: (s: string) => void;
  setCommit: (b: boolean) => void;
  runQuery: (expr?: string) => Promise<void>;
  captureToLedger: (expr: string) => Promise<void>;
  setAlter: (p: Partial<AlterForm>) => void;
  saveAlter: () => Promise<void>;
  migrate: (run: boolean) => Promise<void>;
}

const emptyTable = (): TableState => ({ columns: [], rows: [], total: 0, page: 1, perPage: 50, loading: false });

export const useOrmStore = create<OrmState>((set, get) => ({
  loaded: false,
  models: [],
  selected: null,
  search: '',
  contentTab: 'grid',
  table: emptyTable(),
  source: '',
  relationships: [],
  alter: { table: '', fillable: '', casts: '', saving: false },
  consoleInput: '',
  consoleLog: [],
  commit: false,
  running: false,
  migrateOutput: null,

  load: async () => {
    try {
      const { models } = await rpc<{ models: ModelInfo[] }>('models.list');
      set({ loaded: true, models });
      if (models.length && !get().selected) await get().select(models[0].name);
    } catch (e) {
      set({ loaded: true, consoleLog: [{ expr: '(load)', ok: false, error: (e as Error).message }] });
    }
  },

  refresh: async () => {
    const { models } = await rpc<{ models: ModelInfo[] }>('models.list');
    set({ models });
    if (get().selected) await get().select(get().selected!);
  },

  select: async (name) => {
    const model = get().models.find((m) => m.name === name);
    set({ selected: name, table: { ...emptyTable(), loading: true }, source: '', relationships: [] });
    // Grid + source + relationships in parallel.
    const [table, src, rel] = await Promise.all([
      rpc<{ ok: boolean; columns?: Column[]; rows?: Record<string, unknown>[]; total?: number; error?: string }>('models.table', { model: name, page: 1, perPage: 50 }),
      model ? rpc<{ source: string }>('fs.read', { path: model.path }).catch(() => ({ source: '' })) : Promise.resolve({ source: '' }),
      rpc<{ relationships: Relationship[] }>('models.relationships', { model: name }).catch(() => ({ relationships: [] })),
    ]);
    set({
      table: table.ok
        ? { columns: table.columns ?? [], rows: table.rows ?? [], total: table.total ?? 0, page: 1, perPage: 50, loading: false }
        : { ...emptyTable(), error: table.error },
      source: src.source,
      relationships: rel.relationships,
      alter: deriveAlter(src.source),
    });
  },

  setContentTab: (t) => set({ contentTab: t }),
  setSearch: (s) => set({ search: s }),

  loadTable: async (page = 1) => {
    const name = get().selected;
    if (!name) return;
    set({ table: { ...get().table, loading: true } });
    const t = await rpc<{ ok: boolean; columns?: Column[]; rows?: Record<string, unknown>[]; total?: number; error?: string }>('models.table', { model: name, page, perPage: get().table.perPage });
    set({
      table: t.ok
        ? { columns: t.columns ?? [], rows: t.rows ?? [], total: t.total ?? 0, page, perPage: get().table.perPage, loading: false }
        : { ...get().table, loading: false, error: t.error },
    });
  },

  setConsoleInput: (s) => set({ consoleInput: s }),
  setCommit: (b) => set({ commit: b }),

  runQuery: async (expr) => {
    const code = (expr ?? get().consoleInput).trim();
    if (!code || get().running) return;
    set({ running: true, consoleInput: expr ? get().consoleInput : '' });
    const res = await rpc<QueryOutcome>('models.query', { expr: code, commit: get().commit });
    set((s) => ({ running: false, consoleLog: [...s.consoleLog, { expr: code, ...res }].slice(-100) }));
    // A query that wrote with commit may have changed the grid — refresh counts.
    if (res.ok && get().commit) void get().refresh();
  },

  captureToLedger: async (expr) => {
    const res = await rpc<{ ok: boolean; ledger?: LedgerEntry[]; breakpoints?: BreakpointHit[]; id?: string; error?: string }>('models.capture', { expr });
    if (res.ok && res.ledger) {
      useStore.setState({ ledger: res.ledger, breakpointHits: res.breakpoints ?? [] });
      set((s) => ({ consoleLog: [...s.consoleLog, { expr: `// → ledger: ${res.id}`, ok: true, type: 'captured', result: `replayable in the Run panel (${res.id})` }] }));
    } else {
      set((s) => ({ consoleLog: [...s.consoleLog, { expr: `// capture ${expr}`, ok: false, error: res.error ?? 'capture failed' }] }));
    }
  },

  setAlter: (p) => set({ alter: { ...get().alter, ...p, saved: false } }),

  saveAlter: async () => {
    const { alter, selected } = get();
    if (!selected) return;
    set({ alter: { ...alter, saving: true, error: undefined } });
    const props = {
      table: alter.table,
      fillable: alter.fillable.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
      casts: Object.fromEntries(
        alter.casts.split('\n').map((l) => l.split(':').map((s) => s.trim())).filter((p) => p[0] && p[1]).map(([k, v]) => [k, v]),
      ),
    };
    const res = await rpc<{ ok: boolean; error?: string }>('models.alter', { model: selected, props });
    set({ alter: { ...get().alter, saving: false, saved: res.ok, error: res.error } });
    if (res.ok) await get().select(selected); // reload source/table
  },

  migrate: async (run) => {
    set({ migrateOutput: run ? 'running migrate…' : 'checking…' });
    const res = await rpc<{ ok: boolean; output?: string; error?: string }>('models.migrate', { run });
    set({ migrateOutput: res.output ?? res.error ?? '(no output)' });
    if (run && res.ok) void get().refresh();
  },
}));

// Derive the Alter form from the model source (best-effort regex; the AST write
// on save is authoritative).
function deriveAlter(source: string): AlterForm {
  const table = /protected\s+\$table\s*=\s*'([^']*)'/.exec(source)?.[1] ?? '';
  const fillableRaw = /protected\s+\$fillable\s*=\s*\[([^\]]*)\]/s.exec(source)?.[1] ?? '';
  const fillable = [...fillableRaw.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('\n');
  const castsRaw = /protected\s+\$casts\s*=\s*\[([^\]]*)\]/s.exec(source)?.[1] ?? '';
  const casts = [...castsRaw.matchAll(/'([^']*)'\s*=>\s*'([^']*)'/g)].map((m) => `${m[1]}: ${m[2]}`).join('\n');
  return { table, fillable, casts, saving: false };
}

// Dev-only handle for console poking + E2E checks (no-op in production).
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __wpOrmStore?: typeof useOrmStore }).__wpOrmStore = useOrmStore;
}
