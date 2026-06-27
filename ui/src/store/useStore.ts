import { create } from 'zustand';
import { call, ping } from '../rpc/client';
import type {
  FileModel,
  GutterMarker,
  MarkerKind,
  Mode,
  Problem,
  SwapSite,
  TreeModel,
  View,
} from '../types';

interface RunnerInfo {
  language: string;
  phpVersion: string;
  projectRoot: string;
}

interface State {
  // Connection
  runner: RunnerInfo | null;
  connected: boolean;

  // Workspace
  tree: TreeModel | null;
  openPath: string | null;
  source: string;
  structure: FileModel | null;
  problems: Problem[];

  // UI
  mode: Mode;
  view: View;

  // Debug artifacts
  markers: GutterMarker[];
  swaps: SwapSite[];

  // Actions
  connect: () => Promise<void>;
  loadTree: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  toggleMarker: (line: number, kind: MarkerKind) => void;
  addSwap: (swap: SwapSite) => void;
  removeSwap: (path: string, line: number) => void;
  setView: (view: View) => void;
  setMode: (mode: Mode) => void;
}

export const useStore = create<State>((set, get) => ({
  runner: null,
  connected: false,
  tree: null,
  openPath: null,
  source: '',
  structure: null,
  problems: [],
  mode: 'idle',
  view: 'canvas',
  markers: [],
  swaps: [],

  connect: async () => {
    const info = await ping();
    set({ runner: info, connected: info !== null });
  },

  loadTree: async () => {
    const tree = await call<TreeModel>('structure.tree', { root: '.' });
    set({ tree });
  },

  openFile: async (path: string) => {
    const [{ source }, structure, { problems }] = await Promise.all([
      call<{ source: string }>('fs.read', { path }),
      call<FileModel>('structure.file', { path }),
      call<{ problems: Problem[] }>('swap.scan', { path }),
    ]);
    set({ openPath: path, source, structure, problems, view: 'code' });
  },

  toggleMarker: (line, kind) => {
    const { markers, openPath } = get();
    if (!openPath) return;
    const existing = markers.find((m) => m.path === openPath && m.line === line && m.kind === kind);
    if (existing) {
      set({ markers: markers.filter((m) => m !== existing) });
    } else {
      // A line carries at most one kind; replace any other kind on that line.
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
}));
