import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from '../store/useStore';
import type { ClassModel } from '../types';
import { ClassNode } from './ClassNode';
import { layout } from './layout';

const nodeTypes = { classNode: ClassNode };

function buildGraph(): { nodes: Node[]; edges: Edge[] } {
  const tree = useStore.getState().tree;
  if (!tree) return { nodes: [], edges: [] };

  // Path-scoped unique ids: a real Laravel tree has many anonymous migration
  // classes (`return new class extends Migration`) that would collide on name.
  // Skip the anonymous ones (not useful in the diagram) and key the rest by
  // path + fqn + line so nothing clashes.
  const classes: Array<{ model: ClassModel; filePath: string; uid: string }> = [];
  for (const file of tree.files) {
    for (const node of file.nodes) {
      if (node.kind === 'function') continue;
      const model = node as ClassModel;
      if (model.name === '(anonymous)' || !model.name) continue;
      classes.push({ model, filePath: file.path, uid: `${file.path}::${model.fqn || model.name}::${model.line.start}` });
    }
  }

  const byName = new Map(classes.map((c) => [c.model.name, c]));
  const byFqn = new Map(classes.map((c) => [c.model.fqn, c]));

  const nodes: Node[] = classes.map(({ model, filePath, uid }) => {
    const methodCount = model.members.filter((m) => m.kind === 'method').length;
    const propCount = model.members.length - methodCount;
    return {
      id: uid,
      type: 'classNode',
      position: { x: 0, y: 0 },
      data: { model, filePath, width: 240, height: 70 + (methodCount + propCount) * 18 },
    };
  });

  // Inheritance edges where both ends are in the set.
  const edges: Edge[] = [];
  for (const { model, uid } of classes) {
    const targets = [model.extends, ...model.implements].filter(Boolean) as string[];
    for (const t of targets) {
      const target = byFqn.get(t) ?? byName.get(t.split('\\').pop() ?? t);
      if (target && target.uid !== uid) {
        edges.push({ id: `${uid}->${target.uid}`, source: uid, target: target.uid, animated: false, style: { stroke: '#94a3b8' } });
      }
    }
  }

  return { nodes, edges };
}

function CanvasInner() {
  const tree = useStore((s) => s.tree);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  const raw = useMemo(() => buildGraph(), [tree]);

  useEffect(() => {
    let cancelled = false;
    layout(raw.nodes, raw.edges).then((laidOut) => {
      if (!cancelled) {
        setNodes(laidOut);
        setEdges(raw.edges);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [raw]);

  if (!tree) {
    return <div className="canvas-empty">Load a project to see the class diagram.</div>;
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      minZoom={0.15}
      maxZoom={2.5}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} color="#1e293b" />
      <Controls />
      <MiniMap pannable zoomable nodeColor="#3b82f6" maskColor="rgba(2,6,23,0.7)" />
    </ReactFlow>
  );
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
