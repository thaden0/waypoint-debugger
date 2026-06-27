import { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { buildTree, type FolderEntry } from '../canvas/tree';

// A proper collapsible file tree (IDE-style), built from the same folder→file
// hierarchy the canvas uses (single-child folder chains collapsed). Picking a
// file opens it in the editor.
export function Explorer() {
  const tree = useStore((s) => s.tree);
  const root = useMemo(() => (tree ? buildTree(tree.files) : null), [tree]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  if (!root) return <div className="explorer-empty">No project loaded</div>;

  return (
    <div className="explorer">
      {root.folders.map((f) => (
        <FolderRow key={f.path} folder={f} depth={0} collapsed={collapsed} toggle={toggle} />
      ))}
      {root.files.map((file) => (
        <FileRow key={file.path} path={file.path} name={file.name} depth={0} />
      ))}
    </div>
  );
}

function FolderRow({
  folder,
  depth,
  collapsed,
  toggle,
}: {
  folder: FolderEntry;
  depth: number;
  collapsed: Set<string>;
  toggle: (id: string) => void;
}) {
  const id = `dir:${folder.path}`;
  const isOpen = !collapsed.has(id);
  return (
    <>
      <button className="exp-row exp-row--dir" style={{ paddingLeft: depth * 12 + 6 }} onClick={() => toggle(id)}>
        <span className="exp-chevron">{isOpen ? '▾' : '▸'}</span>
        <span className="exp-icon">📁</span>
        <span className="exp-name">{folder.name}</span>
      </button>
      {isOpen && (
        <>
          {folder.folders.map((sub) => (
            <FolderRow key={sub.path} folder={sub} depth={depth + 1} collapsed={collapsed} toggle={toggle} />
          ))}
          {folder.files.map((file) => (
            <FileRow key={file.path} path={file.path} name={file.name} depth={depth + 1} />
          ))}
        </>
      )}
    </>
  );
}

function FileRow({ path, name, depth }: { path: string; name: string; depth: number }) {
  const openPath = useStore((s) => s.openPath);
  const openFile = useStore((s) => s.openFile);
  return (
    <button
      className={'exp-row exp-row--file' + (openPath === path ? ' is-open' : '')}
      style={{ paddingLeft: depth * 12 + 18 }}
      onClick={() => openFile(path)}
      title={path}
    >
      <span className="exp-icon">📄</span>
      <span className="exp-name">{name}</span>
    </button>
  );
}
