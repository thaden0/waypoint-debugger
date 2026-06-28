import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from '../store/useStore';
import { classesByPath } from '../canvas/tree';
import { buildNav, type NavItem } from './navModel';
import { NavNode } from './NavNode';

const nodeTypes = { nav: NavNode };

// Geometry — fixed cards on a fixed grid. Depth → column (x), visible order → row
// (y). A parent is top-aligned with its first child, so multiple branches can be
// open at once and never overlap. Everything is computed; nothing free-floats.
const COL_W = 240;
const NODE_W = 216;
const ROW_H = 54;
const TOP = 14;

interface Placed {
  item: NavItem;
  depth: number;
  x: number;
  y: number;
  parentId: string | null;
}

function NavInner() {
  const tree = useStore((s) => s.tree);
  const openFile = useStore((s) => s.openFile);
  const revealMember = useStore((s) => s.revealMember);
  const { setCenter, fitView } = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const typeBuf = useRef<{ str: string; at: number }>({ str: '', at: 0 });

  const files = useStore((s) => s.files);
  const roots = useMemo<NavItem[]>(() => (files.length ? buildNav(files, classesByPath(tree?.files ?? [])) : []), [files, tree]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'scroll' | 'fit'>('scroll');

  const itemById = useMemo(() => {
    const m = new Map<string, NavItem>();
    const walk = (xs: NavItem[]) => xs.forEach((x) => { m.set(x.id, x); walk(x.children); });
    walk(roots);
    return m;
  }, [roots]);

  // Seed: first root expanded + selected, so there's something live immediately.
  useEffect(() => {
    if (roots.length) {
      setExpanded(new Set([roots[0].id]));
      setSelectedId(roots[0].id);
    } else {
      setExpanded(new Set());
      setSelectedId(null);
    }
  }, [roots]);

  // Top-aligned tree layout over the currently-expanded set.
  const { placed, placedById, parentOf } = useMemo(() => {
    const out: Placed[] = [];
    const byId = new Map<string, Placed>();
    const parent = new Map<string, string | null>();
    let row = 0;
    const visit = (item: NavItem, depth: number, parentId: string | null) => {
      parent.set(item.id, parentId);
      const isExp = expanded.has(item.id) && item.children.length > 0;
      let myRow: number;
      if (isExp) {
        const start = row;
        for (const ch of item.children) visit(ch, depth + 1, item.id);
        myRow = start;
      } else {
        myRow = row;
        row += 1;
      }
      const p: Placed = { item, depth, x: depth * COL_W, y: TOP + myRow * ROW_H, parentId };
      out.push(p);
      byId.set(item.id, p);
    };
    for (const r of roots) visit(r, 0, null);
    return { placed: out, placedById: byId, parentOf: parent };
  }, [roots, expanded]);

  // Ancestor chain of the selection → the lit spine.
  const spineEdges = useMemo(() => {
    const set = new Set<string>();
    let cur = selectedId;
    while (cur) {
      const p = parentOf.get(cur) ?? null;
      if (p) set.add(`${p}>${cur}`);
      cur = p;
    }
    return set;
  }, [selectedId, parentOf]);

  const nodes = useMemo<Node[]>(() =>
    placed.map((p) => ({
      id: p.item.id,
      type: 'nav',
      position: { x: p.x, y: p.y },
      data: {
        item: p.item,
        selected: selectedId === p.item.id,
        expanded: expanded.has(p.item.id),
        hasChildren: p.item.children.length > 0,
      },
      draggable: false,
      selectable: false,
      style: { width: NODE_W },
    })), [placed, selectedId, expanded]);

  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    for (const p of placed) {
      if (!p.parentId) continue;
      const id = `${p.parentId}>${p.item.id}`;
      const lit = spineEdges.has(id);
      out.push({ id, source: p.parentId, target: p.item.id, type: 'smoothstep', selectable: false, className: lit ? 'nav-spine' : 'nav-edge', zIndex: lit ? 2 : 0 });
    }
    return out;
  }, [placed, spineEdges]);

  const openItem = useCallback((it: NavItem) => {
    if (!it.filePath) return;
    if (it.line && (it.kind === 'method' || it.kind === 'property')) revealMember(it.filePath, it.line);
    else openFile(it.filePath);
  }, [openFile, revealMember]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // Click: an item with children toggles its branch (multiple can stay open); a
  // leaf opens its code.
  const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => {
    const it = itemById.get(node.id);
    if (!it) return;
    setSelectedId(it.id);
    if (it.children.length) toggleExpand(it.id);
    else openItem(it);
  }, [itemById, toggleExpand, openItem]);

  const siblingsOf = useCallback((id: string): NavItem[] => {
    const pid = parentOf.get(id) ?? null;
    return pid ? itemById.get(pid)?.children ?? [] : roots;
  }, [parentOf, itemById, roots]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!selectedId) return;
    const cur = itemById.get(selectedId);
    if (!cur) return;
    const sibs = siblingsOf(selectedId);
    const idx = sibs.findIndex((s) => s.id === selectedId);
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (sibs[idx + 1]) setSelectedId(sibs[idx + 1].id); break;
      case 'ArrowUp': e.preventDefault(); if (sibs[idx - 1]) setSelectedId(sibs[idx - 1].id); break;
      case 'ArrowRight': {
        e.preventDefault();
        if (cur.children.length) {
          if (!expanded.has(cur.id)) toggleExpand(cur.id);
          setSelectedId(cur.children[0].id);
        } else openItem(cur);
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (cur.children.length && expanded.has(cur.id)) toggleExpand(cur.id);
        else { const pid = parentOf.get(cur.id); if (pid) setSelectedId(pid); }
        break;
      }
      case 'Enter':
      case ' ': e.preventDefault(); if (cur.children.length) toggleExpand(cur.id); else openItem(cur); break;
      default: {
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const now = Date.now();
          typeBuf.current = { str: now - typeBuf.current.at < 700 ? typeBuf.current.str + e.key : e.key, at: now };
          const q = typeBuf.current.str.toLowerCase();
          const hit = sibs.find((s) => s.name.toLowerCase().startsWith(q));
          if (hit) setSelectedId(hit.id);
        }
      }
    }
  }, [selectedId, itemById, siblingsOf, expanded, parentOf, toggleExpand, openItem]);

  // Focus follows selection (drives the Aria focus ring + keydown target).
  useEffect(() => {
    if (!selectedId) return;
    const el = wrapRef.current?.querySelector<HTMLButtonElement>(`[data-nav-id="${CSS.escape(selectedId)}"]`);
    el?.focus({ preventScroll: true });
  }, [selectedId, nodes]);

  // Viewport: Fit re-fits on every layout change (never magnifies past 1); Scroll
  // keeps zoom locked at 1 and just centres the selection.
  useEffect(() => {
    if (mode === 'fit') {
      const t = setTimeout(() => fitView({ maxZoom: 1, padding: 0.12, duration: 220 }), 30);
      return () => clearTimeout(t);
    }
    const p = selectedId ? placedById.get(selectedId) : null;
    if (p) setCenter(p.x + NODE_W / 2, p.y + ROW_H / 2, { zoom: 1, duration: 220 });
  }, [mode, selectedId, placedById, nodes, fitView, setCenter]);

  if (!tree) return <div className="nav-empty">No project loaded</div>;
  if (!roots.length) return <div className="nav-empty">No classes found</div>;

  return (
    <div className="navigator" ref={wrapRef} role="tree" aria-label="Code navigator" tabIndex={0} onKeyDown={onKeyDown}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        minZoom={mode === 'fit' ? 0.15 : 1}
        maxZoom={1}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        disableKeyboardA11y
        panOnDrag
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        onNodeClick={onNodeClick}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--canvas-dot)" />
        <Panel position="top-left" className="nav-modes">
          <button className={mode === 'scroll' ? 'is-active' : ''} onClick={() => setMode('scroll')}>Scroll</button>
          <button className={mode === 'fit' ? 'is-active' : ''} onClick={() => setMode('fit')}>Fit</button>
        </Panel>
      </ReactFlow>
    </div>
  );
}

export function Navigator() {
  return (
    <ReactFlowProvider>
      <NavInner />
    </ReactFlowProvider>
  );
}
