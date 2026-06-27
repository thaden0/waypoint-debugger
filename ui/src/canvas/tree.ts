import type { Node } from '@xyflow/react';
import type { ClassModel, FileModel } from '../types';

// Builds a folder -> file -> class hierarchy from the flat file list and lays it
// out as nested React Flow nodes (group containers + class nodes). Collapse state
// is honored: a collapsed folder/file renders only its header; an un-expanded
// class renders compact (members appear when expanded). This is the "tree" canvas
// mode — the file-structure shape that zooms down to a class and its members.

export interface ClassEntry {
  model: ClassModel;
  filePath: string;
}
export interface FileEntry {
  name: string;
  path: string;
  classes: ClassEntry[];
}
export interface FolderEntry {
  name: string;
  path: string;
  folders: FolderEntry[];
  files: FileEntry[];
}

const HEADER_H = 32;
const PAD = 15; // inset so nested cards (and their glow) have breathing room
const GAP = 15;
const CLASS_W = 248;
const CLASS_HEAD = 38;
const ROW_H = 19;

export function buildTree(files: FileModel[]): FolderEntry {
  const root: FolderEntry = { name: '', path: '', folders: [], files: [] };

  for (const file of files) {
    const classes: ClassEntry[] = file.nodes
      .filter((n): n is ClassModel => n.kind !== 'function' && (n as ClassModel).name !== '(anonymous)' && !!(n as ClassModel).name)
      .map((model) => ({ model, filePath: file.path }));
    if (classes.length === 0) continue;

    const segments = file.path.split('/');
    const fileName = segments.pop()!;
    let folder = root;
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      let next = folder.folders.find((f) => f.path === acc);
      if (!next) {
        next = { name: seg, path: acc, folders: [], files: [] };
        folder.folders.push(next);
      }
      folder = next;
    }
    folder.files.push({ name: fileName, path: file.path, classes });
  }
  return collapseSingleChildFolders(root);
}

// Collapse chains of single-child folders (app/Http/Controllers -> one box).
function collapseSingleChildFolders(folder: FolderEntry): FolderEntry {
  folder.folders = folder.folders.map(collapseSingleChildFolders);
  for (const f of folder.folders) {
    while (f.folders.length === 1 && f.files.length === 0) {
      const child = f.folders[0];
      f.name = `${f.name}/${child.name}`;
      f.path = child.path;
      f.folders = child.folders;
      f.files = child.files;
    }
  }
  return folder;
}

export function layoutTree(
  root: FolderEntry,
  collapsedGroups: Set<string>,
  expandedClasses: Set<string>,
): Node[] {
  const out: Node[] = [];

  const classId = (c: ClassEntry) => `class:${c.filePath}::${c.model.fqn || c.model.name}`;

  // size a class node
  const classSize = (c: ClassEntry): { w: number; h: number } => {
    const expanded = expandedClasses.has(classId(c));
    const rows = expanded ? c.model.members.length : 0;
    return { w: CLASS_W, h: CLASS_HEAD + rows * ROW_H };
  };

  // Recursively size + emit. Returns the subtree's outer size. Positions are
  // relative to the parent; children are emitted after their parent.
  const emitClass = (c: ClassEntry, parentId: string | undefined, x: number, y: number, depth: number): { w: number; h: number } => {
    const { w, h } = classSize(c);
    out.push({
      id: classId(c),
      type: 'treeClass',
      position: { x, y },
      parentId,
      extent: parentId ? 'parent' : undefined,
      draggable: false,
      selectable: true,
      data: { model: c.model, filePath: c.filePath, id: classId(c), depth },
      style: { width: w, height: h },
    });
    return { w, h };
  };

  const emitFile = (file: FileEntry, parentId: string | undefined, x: number, y: number, depth: number): { w: number; h: number } => {
    const id = `file:${file.path}`;
    const collapsed = collapsedGroups.has(id);
    const childIds: Array<{ c: ClassEntry }> = file.classes.map((c) => ({ c }));
    const node: Node = {
      id,
      type: 'treeGroup',
      position: { x, y },
      parentId,
      extent: parentId ? 'parent' : undefined,
      draggable: false,
      selectable: false,
      data: { kind: 'file', name: file.name, count: file.classes.length, id, depth },
      style: { width: 0, height: 0 },
    };
    out.push(node);
    if (collapsed) {
      node.style = { width: CLASS_W + PAD * 2, height: HEADER_H };
      return { w: CLASS_W + PAD * 2, h: HEADER_H };
    }
    let cy = HEADER_H + PAD;
    let maxW = CLASS_W;
    for (const { c } of childIds) {
      const s = emitClass(c, id, PAD, cy, depth + 1);
      cy += s.h + GAP;
      maxW = Math.max(maxW, s.w);
    }
    const w = maxW + PAD * 2;
    const h = childIds.length ? cy - GAP + PAD : HEADER_H + PAD;
    node.style = { width: w, height: h };
    return { w, h };
  };

  const emitFolder = (folder: FolderEntry, parentId: string | undefined, x: number, y: number, depth: number): { w: number; h: number } => {
    const id = `dir:${folder.path}`;
    const collapsed = collapsedGroups.has(id);
    const count = folder.folders.length + folder.files.length;
    const node: Node = {
      id,
      type: 'treeGroup',
      position: { x, y },
      parentId,
      extent: parentId ? 'parent' : undefined,
      draggable: false,
      selectable: false,
      data: { kind: 'folder', name: folder.name, count, id, depth },
      style: { width: 0, height: 0 },
    };
    out.push(node);
    if (collapsed) {
      node.style = { width: CLASS_W + PAD * 2, height: HEADER_H };
      return { w: CLASS_W + PAD * 2, h: HEADER_H };
    }
    let cy = HEADER_H + PAD;
    let maxW = CLASS_W;
    for (const sub of folder.folders) {
      const s = emitFolder(sub, id, PAD, cy, depth + 1);
      cy += s.h + GAP;
      maxW = Math.max(maxW, s.w);
    }
    for (const file of folder.files) {
      const s = emitFile(file, id, PAD, cy, depth + 1);
      cy += s.h + GAP;
      maxW = Math.max(maxW, s.w);
    }
    const w = maxW + PAD * 2;
    const h = count ? cy - GAP + PAD : HEADER_H + PAD;
    node.style = { width: w, height: h };
    return { w, h };
  };

  // Stack top-level folders/files in a row of columns (depth 0 = outermost).
  let x = 0;
  for (const folder of root.folders) {
    const s = emitFolder(folder, undefined, x, 0, 0);
    x += s.w + GAP * 3;
  }
  for (const file of root.files) {
    const s = emitFile(file, undefined, x, 0, 0);
    x += s.w + GAP * 3;
  }
  return out;
}
