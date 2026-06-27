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

## Next milestone — CDP / framework-state ledger

The node-side capture (vm SliceRunner + Recorder) is done. The browser side is
scaffolded in [`src/transport/cdp.ts`](src/transport/cdp.ts): per the design, FE
capture should ride at the **framework-state** level (Redux store / signals —
already serializable), with replay as **state-injection, not execution-replay**.
The Chrome DevTools Protocol gives the scope *read* for free; turning that into a
restorable, injectable framework-state snapshot is the next piece.
