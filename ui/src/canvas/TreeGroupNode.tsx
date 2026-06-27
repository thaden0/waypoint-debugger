import type { NodeProps } from '@xyflow/react';
import { useStore } from '../store/useStore';

interface GroupData extends Record<string, unknown> {
  kind: 'folder' | 'file';
  name: string;
  count: number;
  id: string;
}

// A folder/file container in the tree canvas. The header collapses the subtree;
// children render inside it (React Flow nested nodes).
export function TreeGroupNode({ data }: NodeProps) {
  const { kind, name, count, id } = data as GroupData;
  const collapsed = useStore((s) => s.collapsedGroups.includes(id));
  const toggleGroup = useStore((s) => s.toggleGroup);

  return (
    <div className={`tree-group tree-group--${kind} ${collapsed ? 'is-collapsed' : ''}`}>
      <button className="tree-group__header" onClick={() => toggleGroup(id)}>
        <span className="tree-group__chevron">{collapsed ? '▸' : '▾'}</span>
        <span className="tree-group__icon">{kind === 'folder' ? '📁' : '📄'}</span>
        <span className="tree-group__name">{name}</span>
        <span className="tree-group__count">{count}</span>
      </button>
    </div>
  );
}
