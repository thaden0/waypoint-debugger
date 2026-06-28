# Waypoint — a visual checkpoint-replay debugger

Waypoint is a development and debugging tool for **PHP / Laravel** and **JS / TS**
that is *not* a step-through debugger. Its core gesture is **reconstruct-state-then-invoke**:
drop waypoints on public method calls during a real run, then re-enter any of them
with the captured state rebuilt — safely, with flagged I/O swapped out and the
whole run wrapped in a transaction that rolls back by default.

> Status: **working vertical slice, two languages.** The PHP analysis core (parse /
> scan / swap / waypoint instrument / capture / reconstruct-invoke), the **resident
> host** (boots the app, runs slices, replays captured waypoints), the **WebSocket**
> control plane (live capture streaming), **whole-request runs** via include-time
> instrumentation (capture across controller → service → model in one real
> request), and the UI (class-diagram canvas, Monaco gutter waypoints, swap
> workbench, unit + request run controls, ledger timeline) are all wired
> end-to-end. A real Laravel app boots via `LaravelHost`; anything else falls back
> to `BareHost`. A **JS/TS adapter** ([runner-js/](runner-js/)) speaks the same
> JSON-RPC contract on the same port, so the same UI drives either language. The
> browser side has a **CDP / framework-state ledger** (`cdp.*` methods): inject an
> agent that rides a Redux store, capture state per action, and time-travel by
> **state-injection, not execution-replay** — validated in a real Chrome.
>
> The workbench around this core has since grown: a keyboard-driven **code
> navigator** (xyflow + React Aria), **editor tabs** with per-tab buffers,
> **non-source/image** viewing, a generated **Routes** view (with a Docker
> introspection fallback), project-wide **search & replace**, an integrated **bash
> terminal**, an **in-project probe**, and **persisted markers + named, replayable
> sessions**. See the **[User Guide](docs/user-guide.md)** for how to use every
> feature, and [docs/tech-design.md](docs/tech-design.md) for the design.

---

## Why it exists

A normal debugger lets you *watch* code run. Waypoint lets you **re-run a slice
from a chosen point with a state you control** — captured from a real request or
authored by hand — without resuming execution mid-function (which PHP can't do).
Because a waypoint is always a **public method call**, replay is just
`$receiver->method(...$args)` on a reconstructed receiver and arguments.

Two capabilities, built in order:

- **(b) Run-from-state** — author a state via the swap UI and invoke. No recording.
- **(a) Waypoint ledger** — capture state at each waypoint crossing during a real
  run, scrub the timeline, re-invoke from any point. Same invoke machinery, fed
  by captured state instead of authored state.

---

## Architecture

```
UI (React + TS + Vite)            Runner (PHP — resident host)
 ├─ Class-diagram canvas           ├─ StructureExtractor  (AST → node model)
 │   @xyflow/react + elkjs         ├─ ProblemScanner      (swap candidates)
 ├─ Monaco editor                  ├─ Swapper             (AST RHS rewrite)
 │   gutter waypoints/breakpoints  ├─ WaypointInstrumenter(capture hooks)
 ├─ Swap workbench                 ├─ SliceRunner         (instrument→load→drive)
 ├─ Run controls + ledger timeline ├─ Recorder            (ledger + tier-3 gate)
 ├─ Live browser pane (iframe)     ├─ Invoker             (reconstruct + invoke)
 └─ Zustand store                  └─ Host (Laravel | Bare) + tx guard
        │                                   │
        ├──────── JSON-RPC 2.0 over WebSocket (live: run, invoke, streamed
        │             captures) ── bin/host.php  ws://127.0.0.1:9778
        └──────── JSON-RPC 2.0 over HTTP (static analysis fallback)
                      bin/server.php  http://127.0.0.1:9777
```

The resident host (`bin/host.php`) boots the target app once and serves the
control plane over a pure-PHP WebSocket. Two run shapes:

- **`run.slice`** — instruments and drives a single class unit in-process (fast,
  authored state).
- **`run.request`** — spawns a fresh subprocess (`bin/request-run.php`) that
  registers a file stream wrapper rewriting the *targeted* files as they're
  `include`d, then drives a real request so capture flows across every waypointed
  class the request touches (controller → service → model). A fresh process per
  run is required because PHP can't redefine a loaded class, so a resident process
  can't re-instrument between runs.

In both, capture hooks stream `ledger.captured` events to the UI as they fire, and
`run.invoke` replays any captured public-method waypoint with reconstructed state
inside a rollback-guarded transaction. `bin/worker.php` is the FrankenPHP
worker-mode variant.

The runner is the concrete **PHP adapter** of a language-neutral contract
(`parse / instrument / swap / capture / reconstruct / transport`). A future JS/TS
adapter exposes the same JSON-RPC method names over the same wire; the structure
model already carries node-kinds (class / function / module / method) for it.

---

## Quickstart

Requirements: PHP 8.2+, Composer, Node 18+.

The one-file launcher checks prerequisites, installs everything, and starts the
host + UI — same command on Debian / Linux / macOS / Windows:

```bash
node waypoint.mjs up --project /path/to/laravel
```

It runs `doctor` (verify PHP/Node/Composer), installs runner + UI deps if missing,
starts the resident host (ws://127.0.0.1:9778) + HTTP fallback (:9777) + the UI
(http://localhost:5180), and opens the browser. `Ctrl-C` stops everything.

```bash
node waypoint.mjs doctor     # just check prerequisites
node waypoint.mjs up         # no --project → bundled fixtures
node waypoint.mjs up --build # serve a production UI build instead of the dev server
```

<details><summary>Manual steps (if you prefer)</summary>

```bash
cd runner && composer install
php bin/smoke.php          # exercises the static core pipeline
composer test             # PHPUnit incl. live slice run + replay + WS
PROJECT_ROOT="$PWD/tests/fixtures" php bin/host.php    # ws://127.0.0.1:9778
cd ../ui && npm install && npm run dev                 # http://localhost:5180
# …or ./dev.sh /path/to/laravel  (bash-only)
```
</details>

Point `PROJECT_ROOT` at any Laravel app to explore it. The UI loads the class
diagram, opens files in the editor, auto-highlights swap candidates, lets you
place waypoints on public-method lines, run a slice with authored args, watch the
ledger fill live, and replay any captured waypoint.

---

## Repo layout

| Path | What |
|---|---|
| `runner/` | PHP runner core + JSON-RPC servers (nikic/php-parser) |
| `runner/src/Structure` | AST → language-neutral structure model |
| `runner/src/Swap` | problem scanner + AST swapper |
| `runner/src/Waypoint` | capture-hook instrumenter |
| `runner/src/Capture` | the ledger primitive + reproducibility gate |
| `runner/src/Reconstruct` | reconstruct + invoke with rollback guard |
| `runner/src/Host` | runner-as-host: Laravel / Bare host + tx guard |
| `runner/src/Instrument` | file stream wrapper — rewrites targeted files on include |
| `runner/src/Run` | SliceRunner (unit) + RequestRunner (whole-request subprocess) |
| `runner/src/Rpc` | JSON-RPC dispatcher, HTTP + WebSocket transports |
| `runner/bin` | `host.php` (WS resident), `server.php` (HTTP), `request-run.php` (subprocess), `worker.php` (FrankenPHP) |
| `runner-js/` | JS/TS adapter — same JSON-RPC contract (TypeScript compiler API + Node `vm`) |
| `runner-js/src/terminal.ts` | standalone PTY WebSocket server for the integrated terminal (`npm run terminal`) |
| `probe/` | `waypoint/probe` — the in-project remote-capture Composer package |
| `ui/` | React + TS UI — language-neutral |
| `ui/src/nav` | the keyboard-driven code navigator (xyflow + React Aria) |
| `ui/src/panels` | editor, Routes, Search, API/Data consoles, Probe, Sessions, Terminal |
| `waypoint.mjs` | one-file cross-platform launcher (`doctor` / `install` / `up`) |
| `docs/user-guide.md` | **the user guide — how to use every feature** |
| `docs/tech-design.md` | the implementation-facing design + decision record |

---

## License

MIT
