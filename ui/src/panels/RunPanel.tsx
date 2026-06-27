import { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import type { ClassModel, InvokeResult } from '../types';

// Capability (b): author an entry (method + args) for the open class and run the
// slice. Waypoints (gutter) + swaps (workbench) ride along. The ledger that comes
// back is capability (a) — captured public-method states you can replay.
export function RunControls() {
  const structure = useStore((s) => s.structure);
  const entryMethod = useStore((s) => s.entryMethod);
  const entryArgs = useStore((s) => s.entryArgs);
  const setEntryMethod = useStore((s) => s.setEntryMethod);
  const setEntryArgs = useStore((s) => s.setEntryArgs);
  const startRun = useStore((s) => s.startRun);
  const startRequest = useStore((s) => s.startRequest);
  const startDebug = useStore((s) => s.startDebug);
  const hasHost = useStore((s) => s.hasHost);
  const lastRun = useStore((s) => s.lastRun);
  const runMode = useStore((s) => s.runMode);
  const setRunMode = useStore((s) => s.setRunMode);
  const reqMethod = useStore((s) => s.reqMethod);
  const reqUri = useStore((s) => s.reqUri);
  const setReqMethod = useStore((s) => s.setReqMethod);
  const setReqUri = useStore((s) => s.setReqUri);
  const waypointCount = useStore((s) => s.markers.filter((m) => m.kind === 'waypoint').length);

  const firstClass = structure?.nodes.find((n) => n.kind !== 'function') as ClassModel | undefined;
  const methods = (firstClass?.members ?? []).filter((m) => m.kind === 'method' && m.visibility === 'public');

  return (
    <div className="run-controls-panel">
      {!hasHost && <div className="warn">Static mode — start the host (<code>php runner/bin/host.php</code>) to run.</div>}

      <div className="mode-switch">
        <button className={runMode === 'unit' ? 'is-active' : ''} onClick={() => setRunMode('unit')}>Unit</button>
        <button className={runMode === 'request' ? 'is-active' : ''} onClick={() => setRunMode('request')}>Request</button>
      </div>

      {runMode === 'unit' ? (
        !firstClass ? (
          <div className="muted">Open a class file to run a unit slice.</div>
        ) : (
          <>
            <label className="field">
              <span>entry</span>
              <select value={entryMethod ?? ''} onChange={(e) => setEntryMethod(e.target.value)}>
                {methods.map((m) => (
                  <option key={m.name} value={m.name}>{firstClass.name}::{m.name}()</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>args (JSON array)</span>
              <textarea value={entryArgs} onChange={(e) => setEntryArgs(e.target.value)} rows={3} spellCheck={false} />
            </label>
            <div className="run-row">
              <button className="primary run-slice" disabled={!hasHost} onClick={() => startRun()}>▷ Run slice</button>
              <button className="debug-btn" disabled={!hasHost} onClick={() => startDebug()} title="Interactive session: pause at breakpoints, step, continue">🐞 Debug</button>
            </div>
            <DebugSession />
          </>
        )
      ) : (
        <>
          <div className="muted">
            Drives a real request through the app, capturing at every waypoint across files ({waypointCount} placed).
          </div>
          <div className="req-line">
            <select value={reqMethod} onChange={(e) => setReqMethod(e.target.value)}>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
            </select>
            <input value={reqUri} onChange={(e) => setReqUri(e.target.value)} placeholder="/checkout" spellCheck={false} />
          </div>
          <button className="primary run-slice" disabled={!hasHost || waypointCount === 0} onClick={() => startRequest()}>
            ▷ Run request
          </button>
        </>
      )}

      {lastRun && !lastRun.paused && (
        <div className={'run-result ' + (lastRun.ok ? 'ok' : 'err')}>
          {lastRun.ok ? (
            <><strong>ok</strong> → <code>{JSON.stringify(lastRun.result ?? 'rendered')}</code></>
          ) : (
            <><strong>error</strong> {lastRun.error}</>
          )}
        </div>
      )}

      {lastRun?.paused && lastRun.breakpoint && (
        <PausedScope id={lastRun.breakpoint.id} scope={lastRun.breakpoint.scope} />
      )}
    </div>
  );
}

// Interactive debug session: pause at breakpoints, step line-by-line, continue.
function DebugSession() {
  const debugActive = useStore((s) => s.debugActive);
  const debugPaused = useStore((s) => s.debugPaused);
  const debugResult = useStore((s) => s.debugResult);
  const debugCommand = useStore((s) => s.debugCommand);

  if (!debugActive && !debugResult) return null;

  if (debugResult && !debugActive) {
    return (
      <div className={'debug-done ' + (debugResult.ok ? 'ok' : 'err')}>
        {debugResult.stopped ? 'debug stopped' : <>finished → <code>{JSON.stringify(debugResult.result)}</code></>}
      </div>
    );
  }

  return (
    <div className="debug-session">
      {debugPaused ? (
        <>
          <div className="debug-session__head">⏸ paused at line <code>{debugPaused.line}</code></div>
          <ScopeView scope={debugPaused.scope} />
          <div className="debug-controls">
            <button className="primary" onClick={() => debugCommand('continue')} title="Continue to next breakpoint">▷ Continue</button>
            <button onClick={() => debugCommand('step')} title="Step to next line">⤵ Step</button>
            <button className="stop" onClick={() => debugCommand('stop')} title="Stop the session">◻ Stop</button>
          </div>
        </>
      ) : (
        <div className="debug-session__running">running… <button className="stop" onClick={() => debugCommand('stop')}>◻ Stop</button></div>
      )}
    </div>
  );
}

function ScopeView({ scope }: { scope: Record<string, { tier: number; type: string; preview: unknown }> }) {
  const entries = Object.entries(scope);
  if (entries.length === 0) return <div className="muted">no locals in scope</div>;
  return (
    <table className="scope">
      <tbody>
        {entries.map(([name, v]) => (
          <tr key={name} className={v.tier === 3 ? 'tier3' : ''}>
            <td className="scope__name">{name}</td>
            <td className="scope__type">{v.type}</td>
            <td className="scope__val"><code>{previewText(v.preview)}</code></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type ScopeVar = { tier: number; type: string; preview: unknown };

// The paused breakpoint scope. Scalar locals are editable — "Apply & continue"
// re-runs the slice with the edited values injected at this line (change a
// variable on the fly), then shows the new result.
function PausedScope({ id, scope }: { id: string; scope: Record<string, ScopeVar> }) {
  const continueWithOverrides = useStore((s) => s.continueWithOverrides);
  const entries = Object.entries(scope);
  const line = Number(id.split(':').pop());

  // Initial expression for each editable (tier-1, non-$this) var.
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [name, v] of entries) {
      if (name !== 'this' && v.tier === 1) m[name] = literalOf(v.preview, v.type);
    }
    return m;
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [edited, setEdited] = useState<Record<string, string>>(initial);
  const dirty = Object.keys(initial).filter((k) => edited[k] !== initial[k]);

  const apply = () => {
    const overrides = dirty.map((name) => ({ var: name, expression: edited[name] }));
    if (overrides.length) continueWithOverrides(line, overrides);
  };

  return (
    <div className="paused">
      <div className="paused__head">⏸ paused at <code>{id}</code></div>
      <table className="scope">
        <tbody>
          {entries.map(([name, v]) => {
            const editable = name in initial;
            return (
              <tr key={name} className={v.tier === 3 ? 'tier3' : ''}>
                <td className="scope__name">{name}</td>
                <td className="scope__type">{v.type}</td>
                <td className="scope__val">
                  {editable ? (
                    <input
                      className={'scope__edit' + (edited[name] !== initial[name] ? ' is-dirty' : '')}
                      value={edited[name] ?? ''}
                      spellCheck={false}
                      onChange={(e) => setEdited({ ...edited, [name]: e.target.value })}
                    />
                  ) : (
                    <code>{previewText(v.preview)}</code>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="primary continue-btn" disabled={dirty.length === 0} onClick={apply}>
        ▶ Apply &amp; continue {dirty.length > 0 ? `(${dirty.length})` : ''}
      </button>
    </div>
  );
}

function literalOf(v: unknown, type: string): string {
  if (v === null || v === undefined) return 'null';
  if (type === 'string') return JSON.stringify(v); // "..." valid in PHP and JS
  if (type === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function previewText(p: unknown): string {
  if (p === null) return 'null';
  if (typeof p === 'object') return JSON.stringify(p);
  return String(p);
}

export function LedgerTimeline() {
  const ledger = useStore((s) => s.ledger);
  const experiment = useStore((s) => s.experiment);
  const openExperiment = useStore((s) => s.openExperiment);

  if (ledger.length === 0) {
    return <div className="muted">No captures yet. Place waypoints and run a slice.</div>;
  }

  return (
    <div className="ledger">
      {ledger.map((e) => {
        const open = experiment?.seq === e.seq;
        return (
          <div key={e.seq} className={'ledger__entry' + (e.reproducible ? '' : ' not-repro') + (open ? ' open' : '')}>
            <div className="ledger__head">
              <span className="seq">#{e.seq}</span>
              <code>{e.id}</code>
              {!e.reproducible && <span className="tier3" title="holds tier-3 state">⚠ not reproducible</span>}
              <button
                className={'ledger__replay-btn' + (open ? ' active' : '')}
                disabled={!e.reproducible}
                onClick={() => openExperiment(e.seq)}
                title="Reconstruct this checkpoint and replay it with what-if inputs"
              >
                {open ? 'close' : 'replay…'}
              </button>
            </div>
            <div className="ledger__args">
              receiver: <code>{e.receiver.type}</code>
              {e.args.length > 0 && (
                <> · args: {e.args.map((a, i) => <code key={i}>{a.type}</code>)}</>
              )}
            </div>
            {open && experiment && <ReplayExperiment />}
          </div>
        );
      })}
    </div>
  );
}

// The replay what-if loop: reconstruct one checkpoint, then re-invoke it with
// edited inputs and diff the outcome against the as-captured baseline.
function ReplayExperiment() {
  const exp = useStore((s) => s.experiment)!;
  const setExpArg = useStore((s) => s.setExpArg);
  const setExpMethod = useStore((s) => s.setExpMethod);
  const setExpMode = useStore((s) => s.setExpMode);
  const runExperiment = useStore((s) => s.runExperiment);

  const dirty =
    exp.method !== exp.defaultMethod || exp.args.some((a) => a.editable && a.text !== a.original);

  return (
    <div className="exp">
      <div className="exp__baseline">
        <span className="exp__label">baseline</span>
        {exp.baseline ? <ResultValue r={exp.baseline} /> : <span className="muted">running…</span>}
        <span className="muted exp__hint">as captured · rolled back</span>
      </div>

      <div className="exp__form">
        <label className="exp__row">
          <span className="exp__rl">method</span>
          <input
            className="exp__method"
            value={exp.method}
            spellCheck={false}
            onChange={(ev) => setExpMethod(ev.target.value)}
          />
        </label>

        {exp.args.map((a, i) => (
          <label className="exp__row" key={i}>
            <span className="exp__rl">
              arg {i} <span className="muted">{a.type}</span>
            </span>
            {a.editable ? (
              <input
                className={'exp__arg' + (a.error ? ' bad' : '') + (a.text !== a.original ? ' edited' : '')}
                value={a.text}
                spellCheck={false}
                onChange={(ev) => setExpArg(i, ev.target.value)}
                title={a.error ?? 'tier-1 — author any JSON value'}
              />
            ) : (
              <span className="exp__arg locked" title={`tier-${a.tier} — kept as captured`}>
                {a.original} <span className="muted">· captured</span>
              </span>
            )}
          </label>
        ))}

        <div className="exp__controls">
          <div className="exp__modes" role="radiogroup" aria-label="run mode">
            <button
              className={'exp__mode' + (exp.mode === 'peek' ? ' on' : '')}
              onClick={() => setExpMode('peek')}
              title="Roll back after landing — safe"
            >
              peek
            </button>
            <button
              className={'exp__mode danger' + (exp.mode === 'destructive' ? ' on' : '')}
              onClick={() => setExpMode('destructive')}
              title="Commit the transaction — writes persist"
            >
              destructive
            </button>
          </div>
          <button className="exp__run" disabled={exp.running} onClick={() => runExperiment()}>
            {exp.running ? 'running…' : exp.mode === 'destructive' ? 'replay + commit' : 'replay'}
          </button>
        </div>
        {exp.mode === 'destructive' && (
          <div className="exp__warn">⚠ destructive — this commits to the database, not a rollback-guarded peek.</div>
        )}
      </div>

      {exp.result && (
        <div className="exp__result">
          <span className="exp__label">{dirty ? 'what-if' : 'replay'}</span>
          <ResultValue r={exp.result} />
          <span className="muted exp__hint">
            {exp.result.mode}
            {exp.result.ok ? ` · ${exp.result.committed ? 'committed' : 'rolled back'}` : ''}
          </span>
          {exp.result.ok && exp.baseline?.ok && <ResultDiff baseline={exp.baseline} result={exp.result} />}
        </div>
      )}
    </div>
  );
}

function ResultValue({ r }: { r: InvokeResult }) {
  if (!r.ok) return <span className="exp__err">error: {r.error}</span>;
  return <code className="exp__val">{previewText(r.preview ?? r.result)}</code>;
}

// Compare a what-if outcome against the baseline. For two numbers we show the
// delta; otherwise a same/changed verdict on the rendered values.
function ResultDiff({ baseline, result }: { baseline: InvokeResult; result: InvokeResult }) {
  const a = baseline.preview ?? baseline.result;
  const b = result.preview ?? result.result;
  if (typeof a === 'number' && typeof b === 'number') {
    const d = b - a;
    if (d === 0) return <span className="exp__diff same">no change</span>;
    return (
      <span className="exp__diff changed">
        {previewText(a)} → {previewText(b)} (Δ {d > 0 ? '+' : ''}{d})
      </span>
    );
  }
  const same = previewText(a) === previewText(b);
  return <span className={'exp__diff ' + (same ? 'same' : 'changed')}>{same ? 'no change' : 'changed vs baseline'}</span>;
}
