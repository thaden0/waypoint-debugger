import ELK from 'elkjs/lib/elk.bundled.js';
import type { Edge, Node } from '@xyflow/react';

const elk = new ELK();

// Layered (Sugiyama) layout — gives arranged class diagrams rather than a
// hand-placed scatter. Nodes are locked to these positions (not free-floating);
// re-running layout animates them to new spots on collapse/expand or flat/tree.
const LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.spacing.nodeNode': '60',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
};

export async function layout(
  nodes: Node[],
  edges: Edge[],
): Promise<Node[]> {
  const graph = {
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children: nodes.map((n) => ({
      id: n.id,
      width: (n.data?.width as number) ?? 240,
      height: (n.data?.height as number) ?? 120,
    })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };

  const result = await elk.layout(graph);
  const positions = new Map(result.children?.map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));

  return nodes.map((n) => ({
    ...n,
    position: positions.get(n.id) ?? n.position,
    // Locked layout: positions are computed, nodes aren't free-dragged by default.
    draggable: false,
  }));
}
