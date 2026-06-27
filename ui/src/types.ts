// Mirror of the runner's language-neutral structure model. Node-kinds keep this
// forward-compatible with the JS/TS adapter even though PHP exercises only
// class/method/property today.

export type NodeKind =
  | 'module'
  | 'class'
  | 'interface'
  | 'trait'
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

export interface TreeModel {
  root: string;
  files: FileModel[];
}

export type ProblemCategory =
  | 'external.db'
  | 'nondeterministic.time'
  | 'nondeterministic.random'
  | 'io.http'
  | 'io.filesystem'
  | 'io.mail'
  | 'io.cache'
  | 'io.queue'
  | 'io.event'
  | 'io.log'
  | 'io.env'
  | 'io.config';

export interface Problem {
  category: ProblemCategory | string;
  label: string;
  line: number;
  endLine: number;
  startCol: number | null;
  endCol: number | null;
  snippet: string;
}

// Editor markers placed in the gutter, like breakpoints in VS Code.
export type MarkerKind = 'breakpoint' | 'waypoint';

export interface GutterMarker {
  path: string;
  line: number;
  kind: MarkerKind;
}

export interface SwapSite {
  path: string;
  line: number;
  mode: 'indirect' | 'replace';
  key?: string;
  expression?: string;
  label: string;
}

export type Mode = 'idle' | 'running';
export type View = 'canvas' | 'code';
