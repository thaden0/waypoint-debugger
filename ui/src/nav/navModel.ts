import { buildTree, type ClassEntry, type FileEntry, type FolderEntry } from '../canvas/tree';

// The navigable hierarchy: folder → file → class → method/property. This is the
// spine of the Miller-column navigator (App → Http → Controllers → UserController
// → login()). Leaves carry a filePath + line so activating one opens the code.
export type NavKind = 'folder' | 'file' | 'class' | 'interface' | 'trait' | 'enum' | 'method' | 'property';

export interface NavItem {
  id: string;
  name: string;
  kind: NavKind;
  children: NavItem[];
  filePath?: string;
  line?: number;
  visibility?: string;
}

const byName = <T extends { name: string }>(xs: T[]) => [...xs].sort((a, b) => a.name.localeCompare(b.name));

function classItem(c: ClassEntry, id: string): NavItem {
  const methods = c.model.members.filter((m) => m.kind === 'method');
  const props = c.model.members.filter((m) => m.kind === 'property');
  // Constructor leads the member list; the class itself is shown to the left of
  // its members by the tree layout, so the column reads ClassName → __construct → …
  methods.sort((a, b) => Number(b.name === '__construct') - Number(a.name === '__construct'));
  // Methods first (declaration order — meaningful for code), then properties.
  const children: NavItem[] = [
    ...methods.map((m) => ({
      id: `${id}::m:${m.name}`,
      name: `${m.name}()`,
      kind: 'method' as const,
      children: [],
      filePath: c.filePath,
      line: m.line.start,
      visibility: m.visibility,
    })),
    ...props.map((p) => ({
      id: `${id}::p:${p.name}`,
      name: p.name,
      kind: 'property' as const,
      children: [],
      filePath: c.filePath,
      line: p.line.start,
      visibility: p.visibility,
    })),
  ];
  const kind = (['class', 'interface', 'trait', 'enum'].includes(c.model.kind) ? c.model.kind : 'class') as NavKind;
  return { id, name: c.model.name, kind, children, filePath: c.filePath, line: c.model.line.start };
}

function fileItem(f: FileEntry): NavItem {
  // One class per file (the common case) collapses file+class into a single
  // node so you don't tap through a redundant level.
  if (f.classes.length === 1) return classItem(f.classes[0], `class:${f.path}`);
  return {
    id: `file:${f.path}`,
    name: f.name,
    kind: 'file',
    filePath: f.path,
    children: f.classes.map((c, i) => classItem(c, `class:${f.path}#${i}`)),
  };
}

function folderItem(folder: FolderEntry): NavItem {
  return {
    id: `dir:${folder.path}`,
    name: folder.name,
    kind: 'folder',
    children: [...byName(folder.folders).map(folderItem), ...byName(folder.files).map(fileItem)],
  };
}

export function buildNav(paths: string[], classes: Map<string, ClassEntry[]>): NavItem[] {
  const root = buildTree(paths, classes);
  return [...byName(root.folders).map(folderItem), ...byName(root.files).map(fileItem)];
}
