import type { NodeProps } from '@xyflow/react';
import type { ClassModel } from '../types';
import { useStore } from '../store/useStore';

interface TreeClassData extends Record<string, unknown> {
  model: ClassModel;
  filePath: string;
  id: string;
}

const KIND_COLOR: Record<string, string> = {
  class: 'var(--kind-class)', interface: 'var(--kind-interface)', trait: 'var(--kind-trait)', enum: 'var(--kind-enum)',
};
const VIS_GLYPH: Record<string, string> = { public: '+', protected: '#', private: '-' };

// A class box in the tree. Header toggles members; clicking a member zooms the
// focus into the editor (reveals that line) — the "all the way down to a method
// in a beautiful editor" gesture.
export function TreeClassNode({ data }: NodeProps) {
  const { model, filePath, id } = data as TreeClassData;
  const expanded = useStore((s) => s.expandedClasses.includes(id));
  const toggleClass = useStore((s) => s.toggleClass);
  const revealMember = useStore((s) => s.revealMember);
  const openFile = useStore((s) => s.openFile);
  const accent = KIND_COLOR[model.kind] ?? '#64748b';

  const methods = model.members.filter((m) => m.kind === 'method');
  const props = model.members.filter((m) => m.kind === 'property');

  return (
    <div className="tree-class" style={{ borderLeftColor: accent }}>
      <button className="tree-class__header" onClick={() => toggleClass(id)} onDoubleClick={() => openFile(filePath)}>
        <span className="tree-class__chevron">{expanded ? '▾' : '▸'}</span>
        <span className="tree-class__kind" style={{ color: accent }}>{model.kind}</span>
        <span className="tree-class__name">{model.name}</span>
        {!expanded && <span className="tree-class__count">{props.length}p · {methods.length}m</span>}
      </button>

      {expanded && (
        <div className="tree-class__members">
          {props.map((p) => (
            <button key={'p' + p.name} className="tree-row" onClick={() => revealMember(filePath, p.line.start)}>
              <span className="vis">{VIS_GLYPH[p.visibility]}</span> {p.name}
              {p.type && <span className="type">: {p.type}</span>}
            </button>
          ))}
          {methods.map((m) => (
            <button
              key={'m' + m.name}
              className={'tree-row' + (m.waypointEligible ? ' waypoint-ok' : '')}
              onClick={() => revealMember(filePath, m.line.start)}
            >
              <span className="vis">{VIS_GLYPH[m.visibility]}</span> {m.name}()
              {m.waypointEligible && <span className="wp-dot" title="valid waypoint anchor" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
