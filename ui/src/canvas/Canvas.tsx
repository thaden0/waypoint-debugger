import { useEffect, useState } from 'react';
import {
  Background,
  ControlButton,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from '../store/useStore';
import type { ClassModel } from '../types';
import { ClassNode } from './ClassNode';
import { layout } from './layout';

const nodeTypes = { classNode: ClassNode };

interface Klass {
  model: ClassModel;
  filePath: string;
  uid: string;
}

// Build the class diagram. With a focused file, show that file's classes plus
// their direct relations (1 hop) — the file's "UML card". Otherwise the whole
// project. elkjs computes a locked, snapped layout (no free-floating).
function buildGraph(focusPath: string | null): { nodes: Node[]; edges: Edge[] } {
  const tree = useStore.getState().tree;
  if (!tree) return { nodes: [], edges: [] };

  const all: Klass[] = [];
  for (const file of tree.files) {
    for (const node of file.nodes) {
      if (node.kind === 'function') continue;
      const model = node as ClassModel;
      if (model.name === '(anonymous)' || !model.name) continue;
      all.push({ model, filePath: file.path, uid: `${file.path}::${model.fqn || model.name}::${model.line.start}` });
    }
  }
  const byName = new Map(all.map((c) => [c.model.name, c]));
  const byFqn = new Map(all.map((c) => [c.model.fqn, c]));
  const related = (k: Klass): Klass[] => {
    const targets = [k.model.extends, ...k.model.implements].filter(Boolean) as string[];
    return targets.map((t) => byFqn.get(t) ?? byName.get(t.split('\\').pop() ?? t)).filter(Boolean) as Klass[];
  };

  // Selection: focal file's classes + 1-hop neighbours (in and out).
  let shown = all;
  const focal = new Set<string>();
  if (focusPath) {
    const focalClasses = all.filter((c) => c.filePath === focusPath);
    if (focalClasses.length > 0) {
      const keep = new Set<string>();
      for (const k of focalClasses) {
        focal.add(k.uid);
        keep.add(k.uid);
        for (const n of related(k)) keep.add(n.uid);
      }
      for (const k of all) {
        if (related(k).some((n) => focal.has(n.uid))) keep.add(k.uid);
      }
      shown = all.filter((c) => keep.has(c.uid));
    }
  }

  const nodes: Node[] = shown.map(({ model, filePath, uid }) => {
    const methodCount = model.members.filter((m) => m.kind === 'method').length;
    const propCount = model.members.length - methodCount;
    return {
      id: uid,
      type: 'classNode',
      position: { x: 0, y: 0 },
      data: { model, filePath, focal: focal.has(uid), width: 240, height: 70 + (methodCount + propCount) * 18 },
    };
  });

  const shownIds = new Set(shown.map((c) => c.uid));
  const edges: Edge[] = [];
  for (const k of shown) {
    for (const target of related(k)) {
      if (shownIds.has(target.uid) && target.uid !== k.uid) {
        edges.push({ id: `${k.uid}->${target.uid}`, source: k.uid, target: target.uid, style: { stroke: 'var(--edge)', strokeWidth: 1.5 } });
      }
    }
  }
  return { nodes, edges };
}

function CanvasInner() {
  const tree = useStore((s) => s.tree);
  const openPath = useStore((s) => s.openPath);
  const { fitView } = useReactFlow();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    let cancelled = false;
    const raw = buildGraph(openPath);
    layout(raw.nodes, raw.edges).then((laidOut) => {
      if (cancelled) return;
      setNodes(laidOut);
      setEdges(raw.edges);
      setTimeout(() => fitView({ padding: 0.18, duration: 300 }), 30);
    });
    return () => { cancelled = true; };
  }, [tree, openPath, fitView]);

  if (!tree) {
    return <div className="canvas-empty">Load a project to see its structure.</div>;
  }
  if (nodes.length === 0) {
    return <div className="canvas-empty">No classes in {openPath ? 'this file' : 'the project'}. Pick a class file in the explorer.</div>;
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode="dark"
      minZoom={0.2}
      maxZoom={2.5}
      nodesDraggable={false}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={26} color="var(--canvas-dot)" />
      <Controls showFitView={false} showInteractive={false}>
        <ControlButton onClick={() => fitView({ padding: 0.18, duration: 300 })} title="Fit view">⌕</ControlButton>
      </Controls>
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
