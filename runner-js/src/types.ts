// The language-neutral structure model — identical shape to the PHP runner's
// output, so the same UI canvas renders either language. JS/TS exercises more
// node-kinds than PHP (function/module beyond class), which the schema already
// anticipated.

export type NodeKind =
  | 'module'
  | 'class'
  | 'interface'
  | 'enum'
  | 'function'
  | 'method'
  | 'property';

export interface Span {
  start: number;
  end: number;
}

export interface Param {
  name: string;
  type: string | null;
  hasDefault: boolean;
  variadic: boolean;
}

export interface MemberModel {
  kind: 'method' | 'property';
  name: string;
  visibility: 'public' | 'protected' | 'private';
  static: boolean;
  abstract?: boolean;
  type?: string | null;
  params?: Param[];
  returnType?: string | null;
  line: Span;
  waypointEligible?: boolean;
}

export interface ClassModel {
  kind: NodeKind;
  name: string;
  namespace: string | null;
  fqn: string;
  extends: string | null;
  implements: string[];
  line: Span;
  members: MemberModel[];
}

export interface FunctionModel {
  kind: 'function';
  name: string;
  line: Span;
  params: Param[];
  returnType: string | null;
}

export interface FileModel {
  path: string;
  kind: 'module';
  namespace: string | null;
  nodes: Array<ClassModel | FunctionModel>;
  error?: string;
}

export interface Problem {
  category: string;
  label: string;
  line: number;
  endLine: number;
  startCol: number | null;
  endCol: number | null;
  snippet: string;
}

export interface SwapSpec {
  line: number;
  mode?: 'indirect' | 'replace';
  key?: string;
  expression?: string;
}

export interface WaypointSpec {
  line: number;
  id?: string;
}

// Tiered capture snapshot — mirrors the PHP Recorder's reproducibility gate.
// tier 1: JSON-safe; tier 2: class instance with serializable own props;
// tier 3: irreproducible (function, symbol, host object, circular).
export interface Snapshot {
  tier: 1 | 2 | 3;
  type: string;
  preview: unknown;
  note?: string;
}

export interface LedgerEntry {
  id: string;
  seq: number;
  receiver: Snapshot;
  args: Snapshot[];
  reproducible: boolean;
}
