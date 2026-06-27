import { useStore } from '../store/useStore';

// Flat, path-sorted file list — the snappy "find an object" entry point. Picking
// a file opens it in the editor; the canvas auto-derives its slice from there.
export function Explorer() {
  const tree = useStore((s) => s.tree);
  const openPath = useStore((s) => s.openPath);
  const openFile = useStore((s) => s.openFile);

  if (!tree) return <div className="explorer-empty">No project loaded</div>;

  return (
    <div className="explorer">
      {tree.files.map((f) => {
        const classes = f.nodes.filter((n) => n.kind !== 'function');
        return (
          <button
            key={f.path}
            className={'explorer__item' + (f.path === openPath ? ' is-open' : '')}
            onClick={() => openFile(f.path)}
            title={f.path}
          >
            <span className="explorer__path">{f.path}</span>
            {classes.length > 0 && <span className="explorer__badge">{classes.map((c) => c.kind === 'function' ? '' : (c as { name: string }).name).join(', ')}</span>}
          </button>
        );
      })}
    </div>
  );
}
