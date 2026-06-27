# Waypoint — JS/TS adapter

The second language adapter. It speaks the **same JSON-RPC method names over the
same wire** as the PHP runner, so the existing UI works unchanged — point it at
this host instead of `runner/bin/host.php` and `structure` / `scan` / `swap` /
`waypoint` / `run` / `invoke` all behave identically; only `runner.info.language`
differs (`js` vs `php`).

This is the concrete proof of the design's "polyglot before any language is
picked": most of the system is language-neutral, and a language is a thin adapter
satisfying a fixed contract.

## Parity with the PHP runner

| Contract slot | PHP fill | JS fill |
|---|---|---|
| `parse → structure model` | nikic/php-parser | TypeScript compiler API |
| `scan` (swap candidates) | DB / now() / Str::random / Http | fetch / Date.now / Math.random / crypto / ORM / process.env |
| `swap` (expression hole) | AST RHS rewrite | AST-range initializer rewrite |
| `waypoint instrument` | `Recorder::capture` at method entry | `globalThis.__wpCapture` at method/fn entry |
| `capture` (ledger + tier gate) | serialize, tier-3 wall | structuredClone, tier-3 wall |
| `host / run` | FrankenPHP / Bare + re-namespace eval | Node `vm` context |
| `reconstruct + invoke` | unserialize + `$r->m(...$a)` | rebuild via proto + `r[m](...a)` |
| `breakpoints` | `get_defined_vars()` at the line | static in-scope names (TDZ-safe) at the line |
| `docker mode` | compose parse/classify/reach + Laravel env | same logic + Node env (DATABASE_URL/REDIS_URL) |
| `transport` | pure-PHP WebSocket | `ws` package |

## Run

```bash
npm install
npm test                      # vitest — mirrors the PHP suite (structure, scan,
                              # swap, waypoint, recorder tiers, slice run + replay,
                              # rpc parity)

PROJECT_ROOT=/path/to/app npm run host   # ws://127.0.0.1:9778 (same port the UI uses)
```

With the JS host running, the UI connects exactly as it does to the PHP host.

## CDP / framework-state ledger (the browser side)

Implemented in [`src/cdp/`](src/cdp/). Per the design, FE capture rides at the
**framework-state** level (a Redux store — already serializable), and replay is
**state-injection, not execution-replay**:

- [`agent.ts`](src/cdp/agent.ts) — a self-contained `waypointAgent(globalThis)`
  injected into the page. It wraps the store's reducer (to honor a `SET_STATE`
  action) and `dispatch` (to record a snapshot per action). `inject(state)` /
  `jump(seq)` time-travel by dispatching `SET_STATE` — the framework re-renders;
  nothing re-executes. This is Redux DevTools time-travel, distilled.
- [`cdpClient.ts`](src/cdp/cdpClient.ts) — a minimal CDP client (commands by id +
  events over the debugger WebSocket).
- [`cdpTransport.ts`](src/cdp/cdpTransport.ts) — `attach` → inject agent;
  `snapshotFrameworkState` / `injectFrameworkState` / `pullLedger` / `jump` via
  `Runtime.evaluate`; `Debugger.paused` gives the VM-level scope *read* for free.
- [`frameworkLedger.ts`](src/cdp/frameworkLedger.ts) — node-side mirror of the
  in-page snapshot log.

RPC methods: `cdp.attach` / `cdp.snapshot` / `cdp.inject` / `cdp.ledger` /
`cdp.jump` / `cdp.scope` / `cdp.detach`.

**Validated** against a mock CDP server (vitest `test/cdp.test.ts`) and against a
**real Chrome** (the agent recorded `@@INIT → inc → login → inc` and `jump(1)`
injected the recorded state to land back at `{count:1, user:null}`).

### Next

Per-framework store discovery (auto-detect Redux/Zustand/signals roots), the
`replaceReducer`-free path for stores that don't expose it, and wiring the FE
ledger into the UI's timeline alongside the node ledger.
