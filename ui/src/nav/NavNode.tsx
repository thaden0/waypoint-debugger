import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { useFocusRing } from 'react-aria';
import type { NavItem } from './navModel';

const TYPE_KINDS = ['class', 'interface', 'trait', 'enum'];
const VIS: Record<string, string> = { public: '+', protected: '#', private: '-' };
const FOLDER_GLYPH = '▤';
const FILE_GLYPH = '❒';

export interface NavNodeData extends Record<string, unknown> {
  item: NavItem;
  selected: boolean;
  expanded: boolean;
  hasChildren: boolean;
}

// A UML-style card (echoing the class diagram in the main canvas). The whole card
// is the target; the chevron only reflects expand state. These are the blocks the
// navigator drills through, multiple branches open at once.
export function NavNode({ data }: NodeProps) {
  const { item, selected, expanded, hasChildren } = data as NavNodeData;
  const { isFocusVisible, focusProps } = useFocusRing();
  const isType = TYPE_KINDS.includes(item.kind);
  const isMember = item.kind === 'method' || item.kind === 'property';

  const cls = [
    'nav-card',
    'kind-' + item.kind,
    isType ? 'is-type' : '',
    selected ? 'is-selected' : '',
    expanded ? 'is-expanded' : '',
    isFocusVisible ? 'is-focus' : '',
  ].join(' ');

  return (
    <div className={cls}>
      <Handle type="target" position={Position.Left} className="nav-handle" isConnectable={false} />
      <button
        type="button"
        data-nav-id={item.id}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren ? expanded : undefined}
        tabIndex={-1}
        className="nav-card__btn"
        {...focusProps}
      >
        <div className="nav-card__head">
          {isType && <span className="nav-card__kind">{item.kind}</span>}
          {isMember ? (
            <span className="nav-card__sym">
              <span className="nav-card__vis">{VIS[item.visibility ?? 'public'] ?? '+'}</span> {item.name}
            </span>
          ) : (
            <span className="nav-card__name">
              {item.kind === 'folder' && <span className="nav-card__glyph">{FOLDER_GLYPH}</span>}
              {item.kind === 'file' && <span className="nav-card__glyph">{FILE_GLYPH}</span>}
              {item.name}
            </span>
          )}
          {hasChildren && <span className="nav-card__more" aria-hidden>{expanded ? '▾' : '▸'}</span>}
        </div>
      </button>
      <Handle type="source" position={Position.Right} className="nav-handle" isConnectable={false} />
    </div>
  );
}
