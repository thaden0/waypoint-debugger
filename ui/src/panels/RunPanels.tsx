import { useStore } from '../store/useStore';

// Running-mode surfaces. Variables (bottom) + a tabbed Console sit beside the
// editor; the right half is the live project browser (iframe + postMessage —
// the isolated option, so the app under debug can't corrupt the debugger). In
// idle mode none of this renders, reclaiming the space for the diagram/editor.

export function BrowserPane() {
  const runner = useStore((s) => s.runner);
  // In a hosted run this points at the FrankenPHP-served entry; until the host
  // is wired, it shows the connection target as a placeholder.
  return (
    <div className="browser-pane">
      <div className="browser-pane__bar">
        <span className="dot dot--live" /> project browser
        <span className="muted">{runner?.projectRoot ?? 'not connected'}</span>
      </div>
      <div className="browser-pane__frame">
        <div className="browser-pane__placeholder">
          The live Laravel response renders here once the FrankenPHP host serves the entry.
          <br />
          Isolated via iframe + postMessage.
        </div>
      </div>
    </div>
  );
}

export function VariablesPanel() {
  return (
    <div className="vars-panel">
      <div className="panel-tabbar">Variables</div>
      <div className="vars-panel__body muted">
        Scope at the current pause appears here. With the CDP bridge (JS phase)
        the read is free; on PHP it rides the injected capture.
      </div>
    </div>
  );
}

export function ConsolePanel() {
  return (
    <div className="console-panel">
      <div className="panel-tabbar">
        <span className="tab is-active">Console</span>
        <span className="tab">Network</span>
        <span className="tab">Ledger</span>
      </div>
      <div className="console-panel__body muted">Runner + app output streams here during a run.</div>
    </div>
  );
}
