// CDP transport — the contract slot for the browser/runtime side. NOT YET
// IMPLEMENTED; this file pins the interface so the rest of the adapter is shaped
// for it.
//
// Per the design (§8/§10 of docs/tech-design.md): on the JS side capture should
// ride at the FRAMEWORK-STATE level, not the VM-execution level. The Chrome
// DevTools Protocol hands the *read* for free — at a pause, Debugger.paused
// carries each frame's scope, Runtime.getProperties / Debugger.evaluateOnCallFrame
// walk any variable, Debugger.setVariableValue writes one back. What it does NOT
// give is a restorable whole-VM blob.
//
// The escape: let the framework feed its own state (a Redux store, a signals
// graph) — already serializable by design for SSR/HMR. The FE ledger entry
// becomes a framework-state snapshot, and replay becomes STATE-INJECTION (dispatch
// the state, let it re-render), not execution-replay. Redux DevTools already is
// this ledger; this transport will absorb it rather than reinvent it.
//
// The in-process vm SliceRunner/Recorder in this adapter already satisfy the
// node-side `capture` / `reconstruct` contract; CdpTransport will satisfy the
// browser-side `transport` + framework-state `capture` slots.

export interface CdpTransport {
  /** Attach to a running page (websocket debugger URL or launched browser). */
  attach(target: { wsUrl: string }): Promise<void>;

  /** Read the framework state tree (Redux store / signals) at the current point. */
  snapshotFrameworkState(): Promise<unknown>;

  /** Re-render by injecting a prior state snapshot (state-injection, not replay). */
  injectFrameworkState(snapshot: unknown): Promise<void>;

  detach(): Promise<void>;
}

export class NotImplementedCdpTransport implements CdpTransport {
  async attach(): Promise<void> {
    throw new Error('CDP transport not yet implemented — next milestone (framework-state ledger)');
  }
  async snapshotFrameworkState(): Promise<unknown> {
    throw new Error('not implemented');
  }
  async injectFrameworkState(): Promise<void> {
    throw new Error('not implemented');
  }
  async detach(): Promise<void> {}
}
