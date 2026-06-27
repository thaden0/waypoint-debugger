import { useStore } from '../store/useStore';
import type { ClassModel } from '../types';

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
            <button className="primary run-slice" disabled={!hasHost} onClick={() => startRun()}>▷ Run slice</button>
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

      {lastRun && (
        <div className={'run-result ' + (lastRun.ok ? 'ok' : 'err')}>
          {lastRun.ok ? (
            <><strong>ok</strong> → <code>{JSON.stringify(lastRun.result ?? 'rendered')}</code></>
          ) : (
            <><strong>error</strong> {lastRun.error}</>
          )}
        </div>
      )}
    </div>
  );
}

export function LedgerTimeline() {
  const ledger = useStore((s) => s.ledger);
  const replay = useStore((s) => s.replay);
  const lastInvoke = useStore((s) => s.lastInvoke);

  if (ledger.length === 0) {
    return <div className="muted">No captures yet. Place waypoints and run a slice.</div>;
  }

  return (
    <div className="ledger">
      {ledger.map((e) => {
        const method = e.id.split('::')[1] ?? e.id;
        const invoked = lastInvoke?.seq === e.seq ? lastInvoke.result : null;
        return (
          <div key={e.seq} className={'ledger__entry' + (e.reproducible ? '' : ' not-repro')}>
            <div className="ledger__head">
              <span className="seq">#{e.seq}</span>
              <code>{e.id}</code>
              {!e.reproducible && <span className="tier3" title="holds tier-3 state">⚠ not reproducible</span>}
              <button disabled={!e.reproducible} onClick={() => replay(e.seq, method)}>
                replay
              </button>
            </div>
            <div className="ledger__args">
              receiver: <code>{e.receiver.type}</code>
              {e.args.length > 0 && (
                <> · args: {e.args.map((a, i) => <code key={i}>{a.type}</code>)}</>
              )}
            </div>
            {invoked && (
              <div className={'ledger__replay ' + (invoked.ok ? 'ok' : 'err')}>
                {invoked.ok ? (
                  <>= <code>{JSON.stringify(invoked.result)}</code> <span className="muted">({invoked.mode}, {invoked.committed ? 'committed' : 'rolled back'})</span></>
                ) : (
                  <>error: {invoked.error}</>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
