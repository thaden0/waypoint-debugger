import { useEffect, useState } from 'react';
import { useStore, type ProbeRecord } from '../store/useStore';

// In-project probe view — pull buffered errors/log events from a running app
// (dev/staging/prod) and, on an error, trace the failing request through the
// instrumented host to reconstruct the backend trace (World-B), here from a
// remote environment.
export function ProbePanel() {
  const url = useStore((s) => s.probeUrl);
  const secret = useStore((s) => s.probeSecret);
  const setUrl = useStore((s) => s.setProbeUrl);
  const setSecret = useStore((s) => s.setProbeSecret);
  const pull = useStore((s) => s.probePull);
  const pulling = useStore((s) => s.probePulling);
  const records = useStore((s) => s.probeRecords);
  const app = useStore((s) => s.probeApp);
  const env = useStore((s) => s.probeEnv);
  const error = useStore((s) => s.probeError);
  const config = useStore((s) => s.probeConfig);
  const pushConfig = useStore((s) => s.probePushConfig);
  const loadProbe = useStore((s) => s.loadProbe);

  useEffect(() => { void loadProbe(); }, [loadProbe]);

  return (
    <div className="probe">
      <div className="probe__bar">
        <span className="probe__title">🛰 probe</span>
        <input className="probe__url" placeholder="http://app/_waypoint/probe" value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
        <input className="probe__secret" type="password" placeholder="secret" value={secret} onChange={(e) => setSecret(e.target.value)} />
        <button className="probe__pull" disabled={pulling || !url} onClick={() => pull()}>{pulling ? 'Pulling…' : '↻ Pull'}</button>
        {app && <span className="probe__env">{app} · <span className={'probe__envtag ' + (env === 'production' ? 'prod' : '')}>{env}</span></span>}
      </div>

      <div className="probe__cfg">
        <label className="probe__cfg-item"><input type="checkbox" checked={config.ring_buffer} onChange={(e) => pushConfig({ ...config, ring_buffer: e.target.checked })} /> ring buffer (dev state-saves)</label>
        <label className="probe__cfg-item">triggers <input className="probe__triggers" placeholder="RuntimeException, …" value={config.triggers.join(', ')} onChange={(e) => pushConfig({ ...config, triggers: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></label>
        <span className="muted probe__cfg-hint">pushed to the probe — controls what it captures remotely</span>
      </div>

      <div className="probe__list">
        {error && <div className="probe__err">✕ {error}</div>}
        {!error && records.length === 0 && <div className="muted probe__empty">No buffered records. Pull after the app hits an error or logs an event.</div>}
        {records.map((r) => <ProbeRow key={r.id} rec={r} />)}
      </div>
    </div>
  );
}

function ProbeRow({ rec }: { rec: ProbeRecord }) {
  const trace = useStore((s) => s.traces[rec.id]);
  const tracing = useStore((s) => s.tracing);
  const traceRecord = useStore((s) => s.traceProbeRecord);
  const [open, setOpen] = useState(false);
  const isException = rec.kind === 'exception';

  return (
    <div className={'probe-rec ' + rec.kind}>
      <div className="probe-rec__head" onClick={() => setOpen((v) => !v)}>
        <span className={'probe-rec__kind ' + rec.kind}>{isException ? 'EXCEPTION' : (rec.level ?? 'LOG').toUpperCase()}</span>
        <span className="probe-rec__msg">{rec.class ? <code>{rec.class.split('\\').pop()}</code> : null} {rec.message}</span>
        {rec.request && <span className="probe-rec__req">{rec.request.method} {rec.request.uri}</span>}
        <span className="muted probe-rec__when">{ago(rec.at)}</span>
      </div>
      {open && (
        <div className="probe-rec__body">
          {rec.file && <div className="probe-rec__loc">{rec.file}:{rec.line}</div>}
          {rec.request && (
            <div className="probe-rec__kv">
              <span className="muted">input</span>
              <code>{JSON.stringify(rec.request.input ?? {})}</code>
            </div>
          )}
          {rec.breadcrumbs && rec.breadcrumbs.length > 0 && (
            <div className="probe-rec__crumbs">
              <span className="muted">breadcrumbs before the error ({rec.breadcrumbs.length})</span>
              {rec.breadcrumbs.map((c, i) => (
                <div className={'probe-crumb ' + c.type} key={i}>
                  <span className="probe-crumb__type">{c.type}</span>
                  {c.type === 'query'
                    ? <><code className="probe-crumb__sql">{String(c.data.sql ?? '')}</code><span className="muted probe-crumb__meta">{String(c.data.ms ?? '?')}ms · {String(c.data.bindings ?? 0)} bindings</span></>
                    : <span className="probe-crumb__log"><b>{String(c.data.level ?? '')}</b> {String(c.data.message ?? '')}</span>}
                </div>
              ))}
            </div>
          )}
          {rec.trace && rec.trace.length > 0 && (
            <details className="probe-rec__trace"><summary>{rec.trace.length} frames</summary>
              {rec.trace.slice(0, 12).map((f, i) => <div className="probe-rec__frame" key={i}>{f}</div>)}
            </details>
          )}
          {isException && rec.request && (
            <div className="probe-rec__action">
              {trace ? (
                trace.ok ? (
                  <div className="probe-rec__traceres">
                    <span className="probe-rec__arrow">backend trace →</span>
                    {trace.ledgerCount > 0 ? trace.ledger!.map((e) => <code key={e.seq} className="probe-rec__wp">{e.id}</code>) : <span className="muted">{trace.status} · no waypoints placed</span>}
                  </div>
                ) : <span className="probe-rec__traceerr">trace failed: {trace.error}</span>
              ) : (
                <button className="probe-rec__trace-btn" disabled={tracing === rec.id} onClick={() => traceRecord(rec)}>
                  {tracing === rec.id ? '…' : '→ trace through backend'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
