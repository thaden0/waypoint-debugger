import { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { buildTree, classesByPath, type FolderEntry } from '../canvas/tree';

// Monochrome SVG icons (inherit currentColor, so CSS recolors them — unlike the
// old emoji). Folder is filled, file is outlined, for an at-a-glance distinction.
const FolderIcon = () => (
  <svg className="exp-svg" width="13" height="13" viewBox="0 0 16 16" aria-hidden>
    <path d="M1.6 3.2h4.2l1.3 1.6h6.9a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H1.6a1 1 0 0 1-1-1V4.2a1 1 0 0 1 1-1z" fill="currentColor" />
  </svg>
);
const FileIcon = () => (
  <svg className="exp-svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" aria-hidden>
    <path d="M3.4 1.7h5L11.8 5v8.6a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.3a.6.6 0 0 1 .6-.6z" />
    <path d="M8.2 1.8v3.1h3" />
  </svg>
);

// A collapsible file tree (IDE-style), built from the same folder→file hierarchy
// the navigator uses (single-child folder chains collapsed). Picking a file opens
// it in the editor. This is the quick left-rail jump; the main-area navigator is
// the drill-into-methods surface.
export function Explorer() {
  const tree = useStore((s) => s.tree);
  const files = useStore((s) => s.files);
  const root = useMemo(() => (files.length ? buildTree(files, classesByPath(tree?.files ?? [])) : null), [files, tree]);
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
        <span className="exp-icon"><FolderIcon /></span>
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
      <span className="exp-icon"><FileIcon /></span>
      <span className="exp-name">{name}</span>
    </button>
  );
}
