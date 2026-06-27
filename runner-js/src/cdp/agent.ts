// The browser-side Waypoint agent. It is injected into a running page (via CDP
// Runtime.evaluate) as `(${waypointAgent.toString()})(globalThis)`, so it must be
// SELF-CONTAINED — no imports, no closures over module scope. It is also a plain
// function so it can be unit-tested directly in Node against a mock store.
//
// This is the design's "framework-state escape": rather than snapshotting VM
// execution state, the agent rides the framework's own store. Capture = the state
// tree at each action; replay = STATE-INJECTION (dispatch a reserved action that
// the wrapped reducer honors), not execution-replay. This is exactly how Redux
// DevTools time-travel works, distilled to the minimum.

export interface StoreLike {
  getState(): unknown;
  dispatch(action: { type: string; [k: string]: unknown }): unknown;
  subscribe(listener: () => void): unknown;
  replaceReducer?(reducer: (state: unknown, action: { type: string }) => unknown): void;
}

export interface WaypointApi {
  instrument(store: StoreLike, rootReducer?: (state: unknown, action: { type: string }) => unknown): WaypointApi;
  snapshot(): unknown;
  inject(state: unknown): void;
  jump(seq: number): unknown;
  getLedger(): Array<{ seq: number; action: string; state: unknown }>;
}

export function waypointAgent(target: Record<string, unknown>): WaypointApi {
  var SET = '@@waypoint/SET_STATE';
  var ledger: Array<{ seq: number; action: string; state: unknown }> = [];
  var seq = 0;
  var store: StoreLike | null = null;

  function record(action: { type?: string } | null): void {
    if (!store) return;
    ledger.push({ seq: seq++, action: action && action.type ? String(action.type) : 'unknown', state: store.getState() });
  }

  var api: WaypointApi = {
    instrument: function (s, rootReducer) {
      store = s;
      // Wrap the reducer so a SET_STATE action replaces the whole tree — the
      // injection hook. Needs the root reducer (the app passes it).
      if (rootReducer && s.replaceReducer) {
        s.replaceReducer(function (state: unknown, action: { type: string; state?: unknown }) {
          if (action && action.type === SET) return (action as { state: unknown }).state;
          return rootReducer(state, action);
        });
      }
      // Wrap dispatch to record the post-action state of every real action.
      var origDispatch = s.dispatch.bind(s);
      s.dispatch = function (action: { type: string }) {
        var r = origDispatch(action);
        if (!action || action.type !== SET) record(action);
        return r;
      };
      record({ type: '@@INIT' });
      return api;
    },
    snapshot: function () {
      return store ? store.getState() : null;
    },
    inject: function (state) {
      if (store) store.dispatch({ type: SET, state: state } as { type: string });
    },
    jump: function (s) {
      var e = ledger.find(function (x) {
        return x.seq === s;
      });
      if (e) api.inject(e.state);
      return e ? e.state : null;
    },
    getLedger: function () {
      return ledger.map(function (e) {
        return { seq: e.seq, action: e.action, state: e.state };
      });
    },
  };

  target.__waypoint = api;
  return api;
}

/** The injectable IIFE source — what CDP Runtime.evaluate runs in the page. */
export function agentInjectionSource(): string {
  return `(${waypointAgent.toString()})(globalThis);`;
}
