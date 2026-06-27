import { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { LedgerTimeline } from './RunPanel';

// Running-mode surfaces. Variables (bottom) = the live ledger of captured
// states; Console (tabbed) = the run log + ledger; the right half is the live
// project browser (iframe srcdoc — the isolated option, so the app under debug
// can't corrupt the debugger). Idle mode renders none of this.

export function BrowserPane() {
  const runner = useStore((s) => s.runner);
  const hasHost = useStore((s) => s.hasHost);
  const browserSrc = useStore((s) => s.browserSrc);
  const renderEntry = useStore((s) => s.renderEntry);

  useEffect(() => {
    if (hasHost && !browserSrc) renderEntry('GET', '/');
  }, [hasHost, browserSrc, renderEntry]);

  return (
    <div className="browser-pane">
      <div className="browser-pane__bar">
        <span className="dot dot--live" /> project browser
        <span className="muted">{runner?.host?.app ?? runner?.projectRoot ?? 'not connected'}</span>
        <button className="reload" onClick={() => renderEntry('GET', '/')} disabled={!hasHost}>
          ⟳
        </button>
      </div>
      <div className="browser-pane__frame">
        {browserSrc ? (
          // Isolated document: the real response, sandboxed away from the debugger.
          <iframe title="project" sandbox="allow-same-origin" srcDoc={browserSrc} />
        ) : (
          <div className="browser-pane__placeholder">
            The live response renders here once the host serves an entry.
          </div>
        )}
      </div>
    </div>
  );
}

export function VariablesPanel() {
  return (
    <div className="vars-panel">
      <div className="panel-tabbar">Captured state (ledger)</div>
      <div className="vars-panel__body">
        <LedgerTimeline />
      </div>
    </div>
  );
}

export function ConsolePanel() {
  const log = useStore((s) => s.log);
  const lastRun = useStore((s) => s.lastRun);
  return (
    <div className="console-panel">
      <div className="panel-tabbar">
        <span className="tab is-active">Console</span>
        <span className="tab">Ledger</span>
      </div>
      <div className="console-panel__body">
        {log.length === 0 && <span className="muted">Runner + app output streams here during a run.</span>}
        {log.map((l, i) => (
          <div key={i} className="log-line">
            <span className="muted">›</span> {l}
          </div>
        ))}
        {lastRun?.runtimeClass && <div className="log-line muted">loaded {lastRun.runtimeClass}</div>}
      </div>
    </div>
  );
}
