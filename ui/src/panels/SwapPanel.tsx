import { useState } from 'react';
import { call } from '../rpc/client';
import { useStore } from '../store/useStore';
import type { Problem } from '../types';

// The swap workbench: auto-highlighted problem code on the left becomes swap
// sites (an expression hole — any code in the target language, or an Eloquent
// template). Active swaps + waypoints are listed so a slice is reproducible.
export function SwapPanel() {
  const openPath = useStore((s) => s.openPath);
  const problems = useStore((s) => s.problems);
  const swaps = useStore((s) => s.swaps);
  const markers = useStore((s) => s.markers);
  const addSwap = useStore((s) => s.addSwap);
  const removeSwap = useStore((s) => s.removeSwap);

  const [draft, setDraft] = useState<{ line: number; expr: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const fileSwaps = swaps.filter((s) => s.path === openPath);
  const waypoints = markers.filter((m) => m.path === openPath && m.kind === 'waypoint');

  function startSwap(p: Problem) {
    const template = templateFor(p);
    setDraft({ line: p.line, expr: template });
  }

  function commitSwap() {
    if (!draft || !openPath) return;
    addSwap({
      path: openPath,
      line: draft.line,
      mode: 'replace',
      expression: draft.expr,
      label: `line ${draft.line}`,
    });
    setDraft(null);
  }

  async function previewRewrite() {
    if (!openPath) return;
    const res = await call<{ source: string; applied: number }>('swap.apply', {
      path: openPath,
      swaps: fileSwaps.map((s) => ({ line: s.line, mode: s.mode, key: s.key, expression: s.expression })),
    });
    setPreview(`${res.applied} swap(s) applied — rewritten source ${res.source.length} bytes`);
  }

  if (!openPath) return <div className="swap-panel__empty">Open a file to see swap candidates.</div>;

  return (
    <div className="swap-panel">
      <h3>Problem code <span className="muted">(swap candidates)</span></h3>
      {problems.length === 0 && <div className="muted">No flagged calls in this file.</div>}
      <ul className="problem-list">
        {problems.map((p, i) => (
          <li key={i}>
            <span className={'cat cat--' + p.category.split('.')[0]}>{p.category}</span>
            <code>{p.label}</code>
            <span className="muted">L{p.line}</span>
            <button onClick={() => startSwap(p)}>swap</button>
          </li>
        ))}
      </ul>

      {draft && (
        <div className="swap-draft">
          <div className="muted">replace RHS at line {draft.line} with:</div>
          <textarea value={draft.expr} onChange={(e) => setDraft({ ...draft, expr: e.target.value })} rows={3} />
          <div className="swap-draft__actions">
            <button className="primary" onClick={commitSwap}>add swap</button>
            <button onClick={() => setDraft(null)}>cancel</button>
          </div>
        </div>
      )}

      <h3>Active swaps</h3>
      {fileSwaps.length === 0 && <div className="muted">none</div>}
      <ul className="active-list">
        {fileSwaps.map((s) => (
          <li key={s.line}>
            <span className="muted">L{s.line}</span> <code>{s.expression}</code>
            <button onClick={() => removeSwap(s.path, s.line)}>×</button>
          </li>
        ))}
      </ul>
      {fileSwaps.length > 0 && <button onClick={previewRewrite}>preview rewrite</button>}
      {preview && <div className="preview-note">{preview}</div>}

      <h3>Waypoints <span className="muted">(public-method capture points)</span></h3>
      {waypoints.length === 0 && <div className="muted">none — alt-click a blue-eligible line in the gutter</div>}
      <ul className="active-list">
        {waypoints.map((w) => (
          <li key={w.line}>
            <span className="dot dot--waypoint" /> <span className="muted">L{w.line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Pre-made templates slot into common shapes — Eloquent hydration is the big one.
function templateFor(p: Problem): string {
  if (p.category === 'external.db') {
    return "(new \\App\\Models\\User)->newFromBuilder(['id' => 1, 'email' => 'test@example.com'])";
  }
  if (p.category === 'nondeterministic.time') return "\\Carbon\\Carbon::parse('2024-01-01T00:00:00Z')";
  if (p.category === 'nondeterministic.random') return "'fixed-random-value'";
  if (p.category === 'io.http') return "['status' => 200, 'body' => '{}']";
  return 'null';
}
