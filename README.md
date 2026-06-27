# Waypoint — a visual checkpoint-replay debugger

Waypoint is a development and debugging tool for **PHP / Laravel** (JS/TS planned)
that is *not* a step-through debugger. Its core gesture is **reconstruct-state-then-invoke**:
drop waypoints on public method calls during a real run, then re-enter any of them
with the captured state rebuilt — safely, with flagged I/O swapped out and the
whole run wrapped in a transaction that rolls back by default.

> Status: **early build.** The PHP analysis core (parse / scan / swap / waypoint
> instrument / capture / reconstruct-invoke) and the UI shell (class-diagram
> canvas, Monaco editor with gutter waypoints, swap workbench) are working. The
> FrankenPHP host that boots a real Laravel app and the WebSocket live-run
> transport are the next milestones. See [docs/tech-design.md](docs/tech-design.md).

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
UI (React + TS + Vite)            Runner (PHP, FrankenPHP host)
 ├─ Class-diagram canvas           ├─ StructureExtractor  (AST → node model)
 │   @xyflow/react + elkjs         ├─ ProblemScanner      (swap candidates)
 ├─ Monaco editor                  ├─ Swapper             (AST RHS rewrite)
 │   gutter waypoints/breakpoints  ├─ WaypointInstrumenter(capture hooks)
 ├─ Swap workbench                 ├─ Recorder            (ledger + tier-3 gate)
 └─ Zustand store                  └─ Invoker             (reconstruct + invoke)
        │                                   │
        └──────── JSON-RPC 2.0 ─────────────┘
            (HTTP now; WebSocket for live runs)
```

The runner is the concrete **PHP adapter** of a language-neutral contract
(`parse / instrument / swap / capture / reconstruct / transport`). A future JS/TS
adapter exposes the same JSON-RPC method names over the same wire; the structure
model already carries node-kinds (class / function / module / method) for it.

---

## Quickstart

Requirements: PHP 8.2+, Composer, Node 20+.

```bash
# 1. Runner core
cd runner
composer install
php bin/smoke.php          # 19/19 green — exercises the whole core pipeline

# 2. Start the runner against a project (here, the bundled fixture)
PROJECT_ROOT="$PWD/tests/fixtures" php -S 127.0.0.1:9777 bin/server.php

# 3. UI (separate terminal)
cd ui
npm install
npm run dev               # http://localhost:5180 — proxies /rpc to the runner
```

Point `PROJECT_ROOT` at any Laravel app to explore it. The UI loads the class
diagram, opens files in the editor, auto-highlights swap candidates, and lets you
place waypoints on public-method lines.

There's also a convenience launcher:

```bash
./dev.sh /path/to/laravel    # starts runner + UI together
```

---

## Repo layout

| Path | What |
|---|---|
| `runner/` | PHP runner core + JSON-RPC server (nikic/php-parser) |
| `runner/src/Structure` | AST → language-neutral structure model |
| `runner/src/Swap` | problem scanner + AST swapper |
| `runner/src/Waypoint` | capture-hook instrumenter |
| `runner/src/Capture` | the ledger primitive + reproducibility gate |
| `runner/src/Reconstruct` | reconstruct + invoke with rollback guard |
| `ui/` | React + TS UI (canvas, editor, panels) |
| `docs/tech-design.md` | the implementation-facing design |
| `docs/concept-notes.md` | the rationale record behind the decisions |

---

## License

MIT
