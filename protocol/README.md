# Waypoint wire protocol

The seam between the **host/UI** and a **language runner**. A runner is any process
that speaks this protocol; the same UI drives any of them. This is the contract you
implement to add a language (cf. LSP/DAP) — not a shared base class (runners are
different runtimes), but a method set + framing.

Two runners ship today: `runner/` (PHP) and `runner-js/` (JS/TS). Both realize the
method set below.

## Transport & framing

- **Primary:** WebSocket, `ws://127.0.0.1:<port>` (PHP host default `9778`). Full
  capability (resident booted app → run, invoke, capture streaming).
- **Fallback:** HTTP `POST /rpc` (PHP `9777`) for static analysis when no resident
  host is up. The UI proxies `/rpc` to it.
- **Messages:** JSON-RPC 2.0. Requests `{jsonrpc:"2.0", id, method, params}` →
  responses `{jsonrpc:"2.0", id, result|error}`. Server-initiated **notifications**
  (no `id`) stream events: `{jsonrpc:"2.0", method, params}`.

## Capability negotiation

The first call is `runner.info`. Its `capabilities` array tells the UI what the
runner supports; the UI shows/hides features accordingly.

```jsonc
runner.info → {
  language: "php" | "js",
  projectRoot: string,
  capabilities: string[],   // e.g. ["structure","scan","swap","waypoint","ledger",
                            //       "api","host","run","invoke","orm","cdp","docker"]
  host?: { driver: string, app: string } | null
}
```

A runner implements only the capabilities it advertises; unknown methods return
JSON-RPC error `-32601`.

## Method catalog (by capability)

**core / analysis** (no host required)
- `fs.list`, `fs.read {path}`, `fs.write {path, source}`
- `structure.file {path, source?}`, `structure.tree {root?}`
- `swap.scan {path|source}`, `swap.apply {source, swaps[]}`
- `waypoint.instrument {source, waypoints[]}`
- `ledger.get`, `ledger.reset`
- `project.open {root}` — re-point the served project (rebuilds the framework module)

**host** (resident, booted app) — capability `host`
- `host.describe`, `host.boot`, `host.entry {method, uri, params}`

**run / invoke** — capability `run`, `invoke`
- `run.slice {…}` — instrument + run one method (waypoints/breakpoints/swaps)
- `run.request {targets, entry}` — whole-request capture across files
- `run.invoke {seq|entry, method, mode, argOverrides?}` — reconstruct + invoke
- `run.debug.start|continue|step|stop` — interactive pause/resume

**api console** — capability `api`
- `api.routes` — framework `RouteProvider`: introspect the app's routes (fresh boot)
- `api.send {target, method, uri|url, query, headers, body, …}` — in-process
  (instrumented, captures) or external (server-side HTTP)
- `api.collection.load`, `api.collection.save {collection}` — `.waypoint/api.json`

**orm / data console** — capability `orm`
- `models.list` — framework `OrmProvider`: discover models
- `models.query {expr, commit}` — evaluate the framework's ORM expression
  (transaction-guarded: peek rolls back, commit persists); returns rendered result
  + the SQL it ran
- `models.table {model, page, perPage, filters}` — rows + schema columns
- `models.relationships {model}`, `models.alter {model, props}`, `models.migrate {run}`
- `models.capture {expr}` — snapshot a queried record into the ledger (replay bridge)

**docker** — capability `docker`: `docker.scan|up|down`
**browser state** (JS) — capability `cdp`: `cdp.attach|snapshot|inject|ledger|jump|scope|detach`

## Notifications (server → UI)

- `ledger.captured {…entry}` — a waypoint fired during a run
- `breakpoint.hit {id, scope}` — a breakpoint was crossed (trace mode)
- `debug.paused {id, line, scope}` / `debug.finished {…}` — interactive session

## Modules

Framework-specific behavior lives behind providers a **framework module** supplies
to its language runner (see `runner/src/Module/` and `runner/modules/`):

- `RouteProvider` → `api.routes`
- `OrmProvider`  → `models.*`
- a host (`HostInterface`) → `host.*` / `run.*`

A module declares itself with a `module.json` manifest (see
[modules.md](./modules.md)). Adding a framework = add a module; adding a language =
add a runner that speaks this protocol.
