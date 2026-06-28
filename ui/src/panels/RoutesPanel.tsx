import { useEffect, useMemo, useState } from 'react';
import { useApiStore } from '../store/apiStore';
import { useStore } from '../store/useStore';
import type { ClassModel } from '../types';

// A generated map of the app's HTTP routes (method · URI · name · Controller@action)
// introspected from a fresh boot. Each resolvable row jumps straight to the
// controller method in the editor — the routes-as-navigation surface.
export function RoutesPanel() {
  const routes = useApiStore((s) => s.routes);
  const loaded = useApiStore((s) => s.loaded);
  const load = useApiStore((s) => s.load);
  const refreshRoutes = useApiStore((s) => s.refreshRoutes);
  const refreshing = useApiStore((s) => s.refreshing);
  const tree = useStore((s) => s.tree);
  const revealMember = useStore((s) => s.revealMember);
  const openFile = useStore((s) => s.openFile);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!loaded) void load();
    else void refreshRoutes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // class FQN (and short name) -> { file path, method -> line }
  const index = useMemo(() => {
    const m = new Map<string, { path: string; methods: Map<string, number> }>();
    for (const f of tree?.files ?? []) {
      for (const n of f.nodes) {
        if (n.kind === 'function') continue;
        const cls = n as ClassModel;
        const methods = new Map<string, number>();
        for (const mem of cls.members) if (mem.kind === 'method') methods.set(mem.name, mem.line.start);
        const entry = { path: f.path, methods };
        if (cls.fqn) m.set(cls.fqn.replace(/^\\/, ''), entry);
        if (cls.name) m.set(cls.name, entry);
      }
    }
    return m;
  }, [tree]);

  const resolve = (action: string): { path: string; line?: number } | null => {
    if (!action || action === 'Closure') return null;
    const [fqnRaw, method] = action.includes('@') ? action.split('@') : [action, '__invoke'];
    const fqn = fqnRaw.replace(/^\\/, '');
    const hit = index.get(fqn) ?? index.get(fqn.split('\\').pop() ?? fqn);
    if (!hit) return null;
    return { path: hit.path, line: hit.methods.get(method) };
  };

  const jump = (action: string) => {
    const r = resolve(action);
    if (!r) return;
    if (r.line) void revealMember(r.path, r.line);
    else void openFile(r.path);
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return routes;
    return routes.filter((r) => `${r.uri} ${r.name ?? ''} ${r.action} ${r.methods.join(' ')}`.toLowerCase().includes(needle));
  }, [routes, q]);

  return (
    <div className="routes">
      <div className="routes__bar">
        <span className="routes__title">🧭 routes</span>
        <input className="routes__search" placeholder="filter by uri, name, action, method…" value={q} spellCheck={false} onChange={(e) => setQ(e.target.value)} />
        <button className="routes__refresh" disabled={refreshing} onClick={() => refreshRoutes()} title="Re-introspect routes">{refreshing ? '…' : '↻'}</button>
        <span className="muted routes__count">{filtered.length}/{routes.length}</span>
      </div>

      <div className="routes__list">
        {routes.length === 0 && (
          <div className="muted routes__empty">
            No routes. Route introspection boots the app — the project's PHP version + dependencies must load on the host (or via Docker).
          </div>
        )}
        {filtered.map((r, i) => {
          const target = resolve(r.action);
          return (
            <div
              key={`${r.uri}:${r.methods.join()}:${i}`}
              className={'route-row' + (target ? ' is-jump' : '')}
              onClick={() => jump(r.action)}
              title={target ? 'Jump to controller method' : r.action}
            >
              <span className="route-row__methods">
                {r.methods.filter((m) => m !== 'HEAD').map((m) => (
                  <span key={m} className={'route-m m-' + m.toLowerCase()}>{m}</span>
                ))}
              </span>
              <span className="route-row__uri">/{r.uri.replace(/^\//, '')}</span>
              {r.name && <span className="route-row__name">{r.name}</span>}
              <span className="route-row__action">{shortAction(r.action)}</span>
              {r.middleware.length > 0 && <span className="route-row__mw">{r.middleware.join(' · ')}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function shortAction(action: string): string {
  if (!action || action === 'Closure') return 'Closure';
  const [fqn, method] = action.includes('@') ? action.split('@') : [action, ''];
  const cls = fqn.split('\\').pop() ?? fqn;
  return method ? `${cls}@${method}` : cls;
}
