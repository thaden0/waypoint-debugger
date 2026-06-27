import type { NodeProps } from '@xyflow/react';
import { useStore } from '../store/useStore';

interface GroupData extends Record<string, unknown> {
  kind: 'folder' | 'file';
  name: string;
  count: number;
  id: string;
  depth: number;
}

// A folder/file container in the tree canvas. Onyx shade alternates by nesting
// depth; the outermost (depth 0) carries the signature red glow. The header
// collapses the subtree; children render inside it (React Flow nested nodes).
export function TreeGroupNode({ data }: NodeProps) {
  const { kind, name, count, id, depth } = data as GroupData;
  const collapsed = useStore((s) => s.collapsedGroups.includes(id));
  const toggleGroup = useStore((s) => s.toggleGroup);

  return (
    <div
      className={`tree-group ${collapsed ? 'is-collapsed' : ''} ${depth === 0 ? 'is-root' : ''}`}
      data-depth={depth % 2}
    >
      <button className="tree-group__header" onClick={() => toggleGroup(id)}>
        <span className="tree-group__chevron">{collapsed ? '▸' : '▾'}</span>
        <span className="tree-group__icon">{kind === 'folder' ? '▣' : '▢'}</span>
        <span className="tree-group__name">{name}</span>
        {collapsed && <span className="tree-group__count">{count}</span>}
      </button>
    </div>
  );
}
