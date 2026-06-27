import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from '../store/useStore';
import type { ClassModel } from '../types';
import { ClassNode } from './ClassNode';
import { TreeGroupNode } from './TreeGroupNode';
import { TreeClassNode } from './TreeClassNode';
import { buildTree, layoutTree } from './tree';
import { layout } from './layout';

const nodeTypes = { classNode: ClassNode, treeGroup: TreeGroupNode, treeClass: TreeClassNode };

function buildFlatGraph(): { nodes: Node[]; edges: Edge[] } {
  const tree = useStore.getState().tree;
  if (!tree) return { nodes: [], edges: [] };

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

  const edges: Edge[] = [];
  for (const { model, uid } of classes) {
    const targets = [model.extends, ...model.implements].filter(Boolean) as string[];
    for (const t of targets) {
      const target = byFqn.get(t) ?? byName.get(t.split('\\').pop() ?? t);
      if (target && target.uid !== uid) {
        edges.push({ id: `${uid}->${target.uid}`, source: uid, target: target.uid, style: { stroke: '#94a3b8' } });
      }
    }
  }
  return { nodes, edges };
}

function CanvasInner() {
  const tree = useStore((s) => s.tree);
  const canvasMode = useStore((s) => s.canvasMode);
  const setCanvasMode = useStore((s) => s.setCanvasMode);
  const collapsedGroups = useStore((s) => s.collapsedGroups);
  const expandedClasses = useStore((s) => s.expandedClasses);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Tree mode is synchronous; flat mode runs elk.
  const treeRoot = useMemo(() => (tree ? buildTree(tree.files) : null), [tree]);

  useEffect(() => {
    let cancelled = false;
    if (canvasMode === 'tree') {
      if (treeRoot) {
        setNodes(layoutTree(treeRoot, new Set(collapsedGroups), new Set(expandedClasses)));
        setEdges([]);
      }
      return;
    }
    const raw = buildFlatGraph();
    layout(raw.nodes, raw.edges).then((laidOut) => {
      if (!cancelled) {
        setNodes(laidOut);
        setEdges(raw.edges);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canvasMode, treeRoot, collapsedGroups, expandedClasses]);

  if (!tree) {
    return <div className="canvas-empty">Load a project to see the structure.</div>;
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      minZoom={0.1}
      maxZoom={2.5}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} color="#1e293b" />
      <Controls />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => (n.type === 'treeGroup' ? '#334155' : '#3b82f6')}
        nodeStrokeColor="#0b1120"
        maskColor="rgba(2,6,23,0.7)"
      />
      <Panel position="top-left" className="canvas-mode">
        <button className={canvasMode === 'tree' ? 'is-active' : ''} onClick={() => setCanvasMode('tree')}>Tree</button>
        <button className={canvasMode === 'flat' ? 'is-active' : ''} onClick={() => setCanvasMode('flat')}>Flat</button>
      </Panel>
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
