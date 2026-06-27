import vm from 'node:vm';
import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { waypointAgent } from '../src/cdp/agent.js';
import { CdpClient } from '../src/cdp/cdpClient.js';
import { CdpTransport } from '../src/cdp/cdpTransport.js';
import { FrameworkStateLedger } from '../src/cdp/frameworkLedger.js';

// A minimal Redux-like store, used both to unit-test the agent and inside the
// mock CDP "page".
const REDUX_LITE = `
  function __createStore(reducer) {
    var state; var listeners = []; var current = reducer;
    var store = {
      getState: function () { return state; },
      dispatch: function (a) { state = current(state, a); listeners.forEach(function (l) { l(); }); return a; },
      subscribe: function (l) { listeners.push(l); return function () {}; },
      replaceReducer: function (r) { current = r; },
    };
    state = current(undefined, { type: '@@init' });
    return store;
  }
  function __reducer(s, a) {
    s = s || { count: 0 };
    if (a.type === 'inc') return { count: s.count + 1 };
    if (a.type === 'dec') return { count: s.count - 1 };
    return s;
  }
  var __store = __createStore(__reducer);
`;

describe('FrameworkStateLedger', () => {
  it('stores snapshots and returns the state to inject', () => {
    const l = new FrameworkStateLedger();
    l.sync([
      { seq: 0, action: '@@INIT', state: { count: 0 } },
      { seq: 1, action: 'inc', state: { count: 1 } },
    ]);
    expect(l.size).toBe(2);
    expect(l.stateAt(1)).toEqual({ count: 1 });
    expect(l.stateAt(99)).toBeNull();
  });
});

describe('browser agent (state-injection time-travel)', () => {
  it('records snapshots per action and jumps by injecting state', () => {
    // Build a real store via the lite redux, instrument it with the agent.
    const ctx: any = {};
    vm.createContext(ctx);
    vm.runInContext(REDUX_LITE, ctx);
    const api = waypointAgent(ctx); // attaches ctx.__waypoint
    api.instrument(ctx.__store, ctx.__reducer);

    ctx.__store.dispatch({ type: 'inc' });
    ctx.__store.dispatch({ type: 'inc' });
    ctx.__store.dispatch({ type: 'dec' });

    const ledger = api.getLedger();
    expect(ledger.map((e) => e.action)).toEqual(['@@INIT', 'inc', 'inc', 'dec']);
    expect(ledger.map((e: any) => e.state.count)).toEqual([0, 1, 2, 1]);
    expect(api.snapshot()).toEqual({ count: 1 });

    // Time-travel to seq 0 by INJECTING its state — no re-execution.
    api.jump(0);
    expect(api.snapshot()).toEqual({ count: 0 });
  });
});

// ---- Mock CDP server: a real WebSocket that maintains a vm "page" and answers
// Runtime.evaluate by evaluating in it. Proves the whole transport->agent->store
// loop without a browser. After the agent is injected it instruments the page's
// store and simulates a little app activity.
function startMockCdpServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws) => {
      const ctx: any = {};
      vm.createContext(ctx);
      vm.runInContext(REDUX_LITE, ctx);
      let instrumented = false;

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.method === 'Runtime.evaluate') {
          let value: unknown;
          let exceptionDetails: unknown;
          try {
            value = vm.runInContext(msg.params.expression, ctx);
          } catch (e) {
            exceptionDetails = { text: (e as Error).message };
          }
          // First evaluate that installs the agent -> instrument + simulate app.
          if (ctx.__waypoint && !instrumented) {
            instrumented = true;
            ctx.__waypoint.instrument(ctx.__store, ctx.__reducer);
            ctx.__store.dispatch({ type: 'inc' });
            ctx.__store.dispatch({ type: 'inc' });
            ctx.__store.dispatch({ type: 'dec' });
          }
          const result = msg.params.returnByValue
            ? { type: typeof value, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }
            : { type: typeof value };
          // CDP Runtime.evaluate shape: { result: {type,value}, exceptionDetails? }
          const cdpResult = exceptionDetails ? { exceptionDetails, result: {} } : { result };
          ws.send(JSON.stringify({ id: msg.id, result: cdpResult }));
        } else {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
    });
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ url: `ws://127.0.0.1:${port}`, close: () => wss.close() });
    });
  });
}

describe('CdpClient', () => {
  let server: { url: string; close: () => void } | null = null;
  afterEach(() => server?.close());

  it('correlates command responses by id', async () => {
    server = await startMockCdpServer();
    const client = new CdpClient();
    await client.connect(server.url);
    const res = await client.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true });
    expect(res.result.value).toBe(2);
    client.close();
  });
});

describe('CdpTransport (full loop via mock page)', () => {
  let server: { url: string; close: () => void } | null = null;
  afterEach(() => server?.close());

  it('attaches, pulls the ledger, snapshots, and time-travels by injection', async () => {
    server = await startMockCdpServer();
    const transport = new CdpTransport();
    await transport.attach(server.url); // injects the agent -> page instruments + simulates

    // Current state after inc, inc, dec.
    expect(await transport.snapshotFrameworkState()).toEqual({ count: 1 });

    // The in-page ledger pulled to the node side.
    const snapshots = await transport.pullLedger();
    expect(snapshots.map((s) => s.action)).toEqual(['@@INIT', 'inc', 'inc', 'dec']);
    expect(transport.ledger.size).toBe(4);

    // Jump to the initial snapshot by injecting its state — re-render, not replay.
    await transport.jump(0);
    expect(await transport.snapshotFrameworkState()).toEqual({ count: 0 });

    await transport.detach();
  });
});
