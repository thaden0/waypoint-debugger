import { Handle, Position, useStore as useFlowStore } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { ClassModel } from '../types';
import { useStore } from '../store/useStore';

// Zoom thresholds drive level-of-detail. Far out: a labeled box. Mid: the class
// with member rows. (Far in -> open the focused class in the code editor; we do
// not mount a Monaco instance per node — only the focused node gets a real
// editor, every other node stays a cheap static box.)
const SHOW_MEMBERS_ZOOM = 0.7;

interface ClassNodeData extends Record<string, unknown> {
  model: ClassModel;
  filePath: string;
}

const KIND_COLOR: Record<string, string> = {
  class: '#3b82f6',
  interface: '#a855f7',
  trait: '#14b8a6',
  enum: '#f59e0b',
};

const VIS_GLYPH: Record<string, string> = { public: '+', protected: '#', private: '-' };

export function ClassNode({ data }: NodeProps) {
  const { model, filePath } = data as ClassNodeData;
  const zoom = useFlowStore((s) => s.transform[2]);
  const openFile = useStore((s) => s.openFile);
  const revealMember = useStore((s) => s.revealMember);
  const accent = KIND_COLOR[model.kind] ?? '#64748b';
  const detailed = zoom >= SHOW_MEMBERS_ZOOM;

  const methods = model.members.filter((m) => m.kind === 'method');
  const props = model.members.filter((m) => m.kind === 'property');

  return (
    <div
      className="class-node"
      style={{ borderTopColor: accent }}
      onDoubleClick={() => openFile(filePath)}
      title="Double-click to open in the code editor"
    >
      <Handle type="target" position={Position.Top} />
      <div className="class-node__header" style={{ background: accent }}>
        <span className="class-node__kind">{model.kind}</span>
        <span className="class-node__name">{model.name}</span>
      </div>

      {detailed ? (
        <div className="class-node__body">
          {props.length > 0 && (
            <ul className="class-node__members">
              {props.map((p) => (
                <li key={'p' + p.name} className="clickable" onClick={() => revealMember(filePath, p.line.start)}>
                  <span className="vis">{VIS_GLYPH[p.visibility]}</span> {p.name}
                  {p.type ? <span className="type">: {p.type}</span> : null}
                </li>
              ))}
            </ul>
          )}
          <ul className="class-node__members">
            {methods.map((m) => (
              <li
                key={'m' + m.name}
                className={'clickable' + (m.waypointEligible ? ' waypoint-ok' : '')}
                onClick={() => revealMember(filePath, m.line.start)}
              >
                <span className="vis">{VIS_GLYPH[m.visibility]}</span> {m.name}()
                {m.waypointEligible && <span className="wp-dot" title="valid waypoint anchor" />}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="class-node__summary">
          {props.length} props · {methods.length} methods
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
