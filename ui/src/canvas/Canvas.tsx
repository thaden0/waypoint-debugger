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

  const classes: Array<{ model: ClassModel; filePath: string }> = [];
  for (const file of tree.files) {
    for (const node of file.nodes) {
      if (node.kind !== 'function') {
        classes.push({ model: node as ClassModel, filePath: file.path });
      }
    }
  }

  const byName = new Map(classes.map((c) => [c.model.name, c]));
  const byFqn = new Map(classes.map((c) => [c.model.fqn, c]));

  const nodes: Node[] = classes.map(({ model, filePath }) => {
    const methodCount = model.members.filter((m) => m.kind === 'method').length;
    const propCount = model.members.length - methodCount;
    return {
      id: model.fqn || model.name,
      type: 'classNode',
      position: { x: 0, y: 0 },
      data: {
        model,
        filePath,
        width: 240,
        height: 70 + (methodCount + propCount) * 18,
      },
    };
  });

  // Inheritance edges where both ends are in the set.
  const edges: Edge[] = [];
  for (const { model } of classes) {
    const id = model.fqn || model.name;
    const targets = [model.extends, ...model.implements].filter(Boolean) as string[];
    for (const t of targets) {
      const target = byFqn.get(t) ?? byName.get(t.split('\\').pop() ?? t);
      if (target) {
        edges.push({
          id: `${id}->${target.model.fqn}`,
          source: id,
          target: target.model.fqn || target.model.name,
          animated: false,
          style: { stroke: '#94a3b8' },
        });
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
