# Visual Checkpoint-Replay Debugger — Technical Design

**Status:** Draft for build. Supersedes the concept notes in `debug-tool-design.md` (which remains the rationale record). This document is the implementation-facing spec: the model we agreed on, the stack, and the build order.

**First target:** PHP / Laravel CRUD. **Second target:** TypeScript / JavaScript.

---

## 1. What we're building

A development and debugging tool that lets a developer:

1. **Run a real entry** (a route the browser hits) and watch it execute, with a live view of the rendered output beside the code.
2. **Drop waypoints** on public method calls — like breakpoints, but they *capture state* — so a reproduced state can be restarted from there.
3. **Highlight and swap** problem code (`User::find(1)`, `now()`, an HTTP call) for arbitrary replacement code or a pre-made template.
4. **Re-invoke from any waypoint** (or from a hand-authored mock entry) with the captured/authored state reconstructed, safely (transaction-rollback), against fakes or the real dockerized services.
5. **Navigate the code as a diagram** — file-structure boxes that zoom down through class diagrams into a full editor.

It is *not* a step-through debugger. The core gesture is **reconstruct-state-then-invoke**, not resume-mid-function.

---

## 2. Core model

### 2.1 The central operation: reconstruct + invoke

Everything reduces to one primitive:

> **Reconstruct the receiver (`$this`) + the arguments of a public method call, then invoke `$receiver->method(...$args)` in a live, booted application, with I/O calls swapped and the whole thing wrapped in a rollback boundary.**

This works *because* we constrain the re-entry point to a **public method call**. A public method is directly re-invokable — we never resume execution in the middle of a function, so PHP's lack of continuations is a non-issue. The "state" we must rebuild is just:

- the **receiver** object (`$this`),
- the **arguments**,
- plus the **ambient application state** (container singletons, config, DB), which the runner supplies for free by keeping Laravel booted.

I/O and non-determinism inside the method body are handled by **swaps** (§4) and **rollback** (§6), not by replaying a prior run.

### 2.2 Slice

A **slice** is the unit the tool reasons about: the bounded subset of code + state + dependencies involved in one operation.

| Boundary | Meaning |
|---|---|
| **Entry** | A controller action, a waypoint method, or a mock entry. |
| **Span** | The code that runs from the entry to the end / next breakpoint. |
| **Live-state surface** | The variables/objects the span reads and writes — what reconstruction must produce. |
| **Dependency surface** | What the span calls out to (DB, relations, HTTP, filesystem) — the swap candidates. |

A candidate slice is derived statically from an entry (AST-walk what it consumes and calls); the user narrows it (mock this, cut here) or widens it.

### 2.3 Waypoint

A **waypoint** is a user-placed capture point, set like a breakpoint but only legal on a **public method call**. (Constructors are deferred — marginally more reconstruction code for little gain.)

- During a real run, each time execution **crosses** a waypoint, the runner captures `{ receiver, args }` at that call.
- A waypoint is later a **re-entry point**: pick it, and the tool reconstructs the captured state and re-invokes.
- Waypoints are sparse and intentional (not "every method") — the UI only *offers* them on valid sites.

### 2.4 Two capabilities, layered

These were conflated as "moving the IP" in the concept doc. They are separate and built in this order:

- **(b) Run-from-arbitrary-state** — the synthesis side. Author state via the mock/swap UI, then invoke. **No recording, no ledger.** This is the tractable, independently valuable core.
- **(a) Waypoint ledger / timeline** — the recording side. Capture state at each waypoint crossing during a real run, building a scrubbable timeline; pick any point and re-invoke.

(a) is just (b) fed by captured states instead of hand-authored ones — **same invoke machinery**, so the timeline is not a separate risky subsystem. If we ever need to cut scope, (a) drops and (b) remains a useful tool.

### 2.5 State reconstruction — three tiers

Reconstruction emits constructable source for captured state:

| Tier | Examples | Strategy |
|---|---|---|
| **1 — Trivial** | scalars, arrays | `var_export` |
| **2 — Hydratable** | Eloquent models, DTOs, Collections | `newFromBuilder([...])` (exists=true) / `make([...])` (exists=false); `setRelation()` per traversed relation |
| **3 — Irreproducible** | live PDO handle, open socket, closure over runtime scope, half-constructed service | **Cannot** be written to source. **Detect and refuse gracefully** — mark the waypoint/node "not reproducible" with the reason. |

Tier 1–2 covers essentially all of a CRUD slice's state. Tier 3 is rare in CRUD; the rule is *detect early and degrade with a clear message*, never emit a script that explodes at runtime. The **"reproducible slice" predicate** runs over the slice's live-state surface and gates the operation.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  UI  (React + TypeScript, Vite)                              │
│  • Canvas (file-tree → class diagram → editor, semantic zoom)│
│  • Monaco editor with gutter waypoints/swaps                 │
│  • Variables / Console panels (mode-dependent)               │
│  • Split-screen project browser (iframe + postMessage)       │
└───────────────▲─────────────────────────────────────────────┘
                │  JSON-RPC 2.0 over WebSocket  (the adapter contract)
┌───────────────▼─────────────────────────────────────────────┐
│  PHP Runner-as-Host  (FrankenPHP worker mode)               │
│  • Boots & keeps Laravel resident                            │
│  • AST parse/instrument (nikic/php-parser)                   │
│  • Capture / reconstruct (ledger primitive)                 │
│  • Swap resolution (fake | real)                            │
│  • Serves the entry, drives execution, rolls back           │
└───────────────┬─────────────────────────────────────────────┘
                │  service-name or host-mapped ports
┌───────────────▼─────────────────────────────────────────────┐
│  Dockerized deps (mysql, redis, …) — left running           │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Runner-as-host

The tool **is the runtime**; Laravel is what it executes. One long-lived process (FrankenPHP worker mode) boots Laravel once and holds it resident, so:

- the booted app supplies ambient state for every re-invoke,
- re-runs are fast (no per-run bootstrap),
- the framework-state-reset machinery FrankenPHP/Octane already ships is **reused as our waypoint-boundary reset**,
- instrumentation, swap, capture, and serving live in one process — no cross-process debug wire.

### 3.2 The per-language adapter contract

Most of the system is language-neutral and written once: canvas/UI, docker orchestration, the coordinator, ledger *orchestration* (which waypoint, reconstruct, invoke, rollback). A thin **adapter** per language satisfies a fixed contract:

| Slot | PHP fill |
|---|---|
| `parse(source) → structure model` | nikic/php-parser → language-neutral node-kind schema |
| `instrument(ast, swaps, waypoints) → source` | inject swap RHS + capture hooks, round-trip faithful |
| `host / run` | FrankenPHP boots app, drives an entry, serves |
| `capture(waypoint) → blob` / `reconstruct(blob)` | the ledger primitive (§2.5) |
| `resolve(swap-site) → fake \| real` | the mock dial (§4, §7) |
| `transport` | invoke / scope / step over the wire |

**Two invariants earn "general":**
1. The **structure model** both parsers emit into is language-neutral (node-kinds: class / function / module / method — from day one, even though PHP only exercises `class`/`method` at launch).
2. The **state blob is opaque to the coordinator** — it stores and returns it, never reads inside. The moment it introspects, it stops being general.

**We do not build the full abstraction up front.** Build PHP concretely; extract the interface when the JS adapter forces each seam. Keep only the cheap future-proofing (node-kinds, opaque blobs).

---

## 4. Swap system

### 4.1 The expression hole

A swap site is an **expression hole**, not a typed-value hole. The form emits *code*:

```php
$user = User::find(1);          // original
$user = $mockUser;              // swapped — or any expression:
$user = (new User)->newFromBuilder(['id' => 1, 'email' => '…']);
$user = fn() => $factory->make();
```

Mechanics:
- **AST-based** (nikic/php-parser): locate the assignment/call node, replace its RHS. Sturdier than string matching, and rides the same parse already done for the diagram and capture hooks — **one instrumentation pass, three payloads** (swaps + waypoint hooks + structure model).
- **Indirection** keeps the source static: `$user = $__swaps['user_1'] ?? User::find(1)`. The UI writes the swap map; the rewritten source doesn't churn per edit.

### 4.2 Auto-highlight "problem code"

Static analysis flags swap candidates in the open file — the same set that breaks isolation/determinism:

- external/non-deterministic calls: query builder & `Model::find/get/first`, `Http::`, `now()`, `Carbon::now()`, `Str::random/uuid`, `rand`, filesystem/`file_*`, `env()`.

These are highlighted in the gutter and inline. The highlight set **is** the "what should I mock?" answer. The user can also highlight anything manually. Highlighting is a *suggester, not a gate*.

### 4.3 Templates

A template pre-fills the hole from a small form:

- **Eloquent model:** `newFromBuilder([...])` (exists=true → later `save()` is UPDATE) or `make([...])` (exists=false → INSERT), with a `setRelation()` slot per relation the span traverses.
- Starter library: Model, Collection, paginated result, Request.

Templates are editable down to arbitrary code after insertion.

### 4.4 The mock dial has two ends

Same interception point, target swapped per site:

- **Fake:** resolve to a literal / hydrated template.
- **Real:** fall through to the live dockerized service (a real query against the mysql container).

"Docker-backing" and "data-mocking" are the same dial at different levels — fake *what* it returns vs. point at *where* the dependency lives.

---

## 5. PHP runner internals

### 5.1 Host

- **FrankenPHP worker mode** — single binary (Caddy-based), boots Laravel once, keeps it resident, serves HTTP directly (replaces nginx + php-fpm for the path we drive). Reuses its Octane-style state-reset between runs.
- Alternatives if FrankenPHP misfits a project: RoadRunner, then Swoole/Octane.

### 5.2 Instrumentation pass

One AST walk (nikic/php-parser, round-trip-faithful printer) produces:

1. the **structure model** for the canvas,
2. **swap rewrites** at chosen sites,
3. **capture hooks** at waypoints — `__capture($waypointId, $this, func_get_args())` injected at the entry of each waypoint method.

Line-map preserved so the editor's gutter ticks map back to original source. We rewrite only project source we control; vendor code is not rewritten (capture is at *call sites we own*, i.e., the public-method boundary).

### 5.3 Capture

At a waypoint crossing: deep-copy receiver + args into an **opaque blob** (deep copy via serialize where serializable; tier-3 fields trip the reproducible-slice predicate and mark the waypoint non-reproducible). The blob is stored by the coordinator, never introspected by it.

### 5.4 Reconstruct + invoke

1. Reset framework state to a clean boundary (FrankenPHP/Octane reset).
2. Emit/evaluate reconstruction source for receiver + args (tier 1–2).
3. Apply active swaps (fake or real).
4. `BEGIN` transaction.
5. `$receiver->method(...$args)`.
6. Capture result / variables / output.
7. **Peek** → `ROLLBACK` and snap back. **Destructive** → keep (still rollback-guarded unless explicitly committed).

The booted app supplies container/config/DB ambiently; swaps neutralize the I/O we flagged.

### 5.5 Determinism — reuse the framework, don't build a generic recorder

The concept doc's "record-and-pin non-deterministic reads" generic layer is **not built**. It is subsumed by:

- **Swaps** for flagged I/O / non-deterministic calls (they're already pinned by the replacement).
- **DB transaction + rollback** for `save()`/writes crossed on replay.
- Laravel's own pins where convenient: `Carbon::setTestNow()`, `Str::createRandomStringsUsing()`, `Str::createUuidsUsing()`, `Http::fake()`, `Queue/Bus/Event/Mail::fake()`.

Only genuinely residual non-determinism (rare) would justify a targeted record-pin later.

---

## 6. Determinism & safety postures

- **Mock mode:** crossed `->save()` hits a fake; side effects neutralized.
- **Docker mode:** the save is real against the live mysql container; the **transaction-wrap-and-rollback** guard covers it. "Real DB but don't mutate it" *is* transaction-rollback.

Every re-invoke is rollback-guarded by default. Committing is an explicit, deliberate action.

---

## 7. Docker mode

The runner lifts out of the compose set and runs as the host process while the rest of the stack stays up.

- **Identifying the PHP service** is a heuristic (build context, image, the one running artisan) that misfires on custom setups → **let the user mark it in the UI**. "The PHP service" is often plural (`queue`, `scheduler`, `horizon`); the user chooses which to subsume vs. leave containerized.
- **Reaching deps:**
  - *Published ports* — works when the dep publishes one; needs a `DB_HOST → 127.0.0.1` + mapped-port override; fails on internal-only deps.
  - *Network-join* (default, robust) — run the runner on the compose network (`docker network connect`); reach deps by service name (`mysql:3306`); the app's `.env` stands with near-zero rewrite.
- **Read-only path:** parse compose, enumerate services, `docker compose up -d <non-runner set>` (pulls `depends_on`), read ports/network, point the runner in — **no mutation of their compose** unless the unpublished-dep case forces network-join.
- **Self add/remove:** the runner can add/remove itself from a docker setup; the files involved are simple.

---

## 8. UI design

### 8.1 Modes (drive layout)

The window reconfigures by mode:

| Mode | Layout |
|---|---|
| **Not running — diagram/code** | Maximum real estate. Canvas or editor full-width. No console/variables panels. |
| **Running** | **Split screen:** left = code + debug panels, right = live project browser. Bottom = **Variables**. Right-of-variables = **Console** (tabbed). Chrome DevTools Protocol connection surfaced here so PHP-side and browser-side land in one place as execution proceeds. |

Panels (variables, console) appear only when running; not-run mode reclaims the space for the diagram/editor.

### 8.2 Code editor — the part you care about most

- **Monaco**, VS Code-style.
- **Gutter ticks on the left, by the line number:**
  - **red** = breakpoint,
  - **blue** = waypoint (only offered on valid public-method-call lines),
  - swap sites highlighted inline + a gutter marker.
- Click the gutter to toggle; invalid waypoint lines simply don't accept a blue tick.
- Swap sites render inline widgets/decorations showing the active replacement, with an edit affordance opening the expression form / template picker.

### 8.3 Canvas — semantic zoom, locked layout

One canvas, level-of-detail rendering driven by zoom:

- **Far out:** file-structure boxes (folders → files), nested.
- **Mid:** UML **class boxes** — fields/methods as rows, handles on rows as binding affordances (wire a node to an entry, a swap, a waypoint).
- **Far in / focused:** the node *becomes* a full Monaco editor zoomed to a property or method.

Details:
- **Locked layout, not free-floating.** elkjs (layered) computes positions; nodes snap and animate to them. Collapse/expand and **flat-vs-tree** toggles just re-run layout. (Optional manual nudge later; default is locked.)
- **Editor instances are lazy:** only the focused node mounts a live Monaco; all others render static syntax-highlighted snippets (shiki). Never mount N editors.
- **Class-diagram waypoints:** a node may expose a waypoint affordance on its **constructor or its first method call** — both acceptable; this is secondary. The **gutter ticks in the code pane are the primary waypoint/swap surface.**
- **Tabs** across the top for multiple open views (a diagram, a file, a console group).

### 8.4 Project browser (right pane)

- Renders the **real Laravel response** the runner produces — this is what lets the tool test the front end (actual output, not a mock).
- **iframe + postMessage + injected hydration state** — the isolated option. Separate document/JS context so the app under debug can't corrupt the debugger. Worth the postMessage boundary given the app can be arbitrarily broken mid-debug.

---

## 9. Tech stack

| Layer | Choice | Why |
|---|---|---|
| UI framework | **React + TypeScript + Vite** | Ecosystem fit for the canvas + editor; ties the front end together. |
| Canvas | **@xyflow/react (React Flow)** | Nested nodes/subflows, custom node renderers, zoom store for LOD. |
| Auto-layout | **elkjs** (layered) | Clean deterministic class-diagram layout; better than dagre for nested containers. |
| Code editor | **Monaco** | VS Code parity: gutter decorations, inline widgets, line-mapping. |
| Static highlight (unfocused nodes) | **shiki** | Fast, accurate, no editor weight. |
| UI state | **Redux Toolkit** | Complex graph/ledger/run state benefits from the action log; its time-travel devtools mirror our own ledger model. (Zustand acceptable if we want less ceremony.) |
| Wire protocol | **JSON-RPC 2.0 over WebSocket** | Same shape as DBGp/CDP; one wire for PHP now and JS later; defines the adapter contract. |
| App shell | **Runner serves the Vite-built app as a local web app** | No Electron/Tauri for v1 (a desktop shell reintroduces a third language for marginal gain). Revisit only if deep OS integration is needed. |
| PHP host | **FrankenPHP worker mode** | Long-lived booted app, direct HTTP, reusable state reset. |
| PHP AST | **nikic/php-parser** | Round-trip-faithful parse/print; pure PHP; powers swaps + capture + structure model. |
| Browser/CDP bridge (running mode, JS phase) | **Chrome DevTools Protocol** | Free scope reads, async-stack stitching; surfaced in the console/variables panels. |

---

## 10. JavaScript / TypeScript phase (later)

Captured here so the v1 schema doesn't paint us into a corner.

- **One live IP, fragmented timeline.** CDP gives one synchronous call stack per pause plus a *read-only* async stack trace (reconstructed history, not restorable frames). `await` points are natural, free boundaries.
- **Capture is the hard slot, not "JS is hard."** At a pause CDP exposes scope for free (`Debugger.paused`, `Runtime.getProperties`, `evaluateOnCallFrame`, `setVariableValue`) — the *read* is free. Turning it into a restorable blob (continuation + pending promise) is the work, and hits the same tier-3 wall (DOM node, socket, closure).
- **The framework-state escape.** Let the framework feed the browser its own state. Capture moves from VM-execution level (hard) to framework-state level (Redux store / signals graph — already serializable for SSR/HMR). **Redux DevTools already is this ledger.** FE ledger entries become **state-injection, not execution-replay** — dispatch the state, let it re-render. The cross-await replay worry mostly evaporates.
- **Structure schema** already carries node-kinds (function/module beyond class), so JS slots in without a schema change.

---

## 11. Build order

**Phase 0 — skeleton**
- FrankenPHP host boots a Laravel app, serves it, split-screen browser pane renders the real response.
- JSON-RPC/WebSocket channel UI ↔ runner.
- Monaco open-a-file with gutter click toggles (red/blue ticks, no behavior yet).

**Phase 1 — capability (b): run-from-state (no ledger)**
- AST parse → structure model → canvas (file-tree → class boxes, locked layout).
- Auto-highlight problem code; swap form + Eloquent template; AST swap via indirection map.
- Mock entry: author receiver + args, **reconstruct + invoke** with transaction-rollback. Variables/console panels in running mode.
- **Deliverable: a useful isolation runner with zero recording.**

**Phase 2 — capability (a): waypoint ledger**
- Waypoint hooks at public-method calls; capture on crossing during a real run.
- Reproducible-slice predicate + "not reproducible" UI state.
- Scrubbable timeline; re-invoke from any waypoint (same Phase-1 machinery).

**Phase 3 — semantic-zoom canvas + docker mode**
- LOD zoom from file boxes → class diagram → focused Monaco; flat/tree toggle; tabs.
- Docker network-join, service-marking UI, read-only bring-up path, self add/remove.

**Phase 4 — JS/TS adapter**
- CDP transport; framework-state ledger (Redux/signals snapshot); extract the adapter interface against the second implementation.

---

## 12. Decisions locked / still open

**Locked:**
- Re-entry granularity = **public method call** (reconstruct receiver + args + invoke). Constructors deferred.
- Determinism via swaps + transaction-rollback + Laravel fakes; **no generic record-pin layer**.
- FrankenPHP host; nikic/php-parser; React + React Flow + elk + Monaco; JSON-RPC/WebSocket; iframe+postMessage browser pane; locked (non-free-floating) layout.
- Primary waypoint/swap surface = **editor gutter**; class-diagram affordance secondary.
- Build (b) before (a); polyglot abstraction deferred until JS forces it.

**Open:**
- **Slice bounding on the canvas** — entry + static-derived surface (auto), vs. explicit draw (node-to-node), vs. both. Drives canvas interaction depth.
- **Class-diagram waypoint anchor** — constructor vs. first method call (both acceptable; low priority).
- **UI state lib** — Redux Toolkit (recommended) vs. Zustand.
- **Destructive-mode commit UX** — how explicit the "actually keep these writes" gesture must be.

---

## 13. Implementation status (as built)

The engine is well ahead of the UI. What works end-to-end, verified against a real
Laravel 13 app and (for JS) a real Chrome:

- **Both language adapters** (PHP via nikic/php-parser; JS/TS via the TS compiler
  API) over one JSON-RPC/WebSocket wire — structure, scan, swap, waypoint, capture,
  reconstruct+invoke, run.slice, run.request.
- **Runner-as-host** (LaravelHost / BareHost / Node vm), **whole-request capture**
  via include-time stream-wrapper instrumentation, **swap of live Eloquent** with
  hydrated-model templates, **tier-2 Collection reconstruction + replay**.
- **Docker mode** (compose parse/classify/reach, up deps, env overrides) — both
  languages, proven against real redis.
- **Breakpoints** (run-to-breakpoint with full scope capture; halt + trace) — both
  languages; JS computes in-scope names statically (no `get_defined_vars()`).
- **CDP / framework-state ledger** (JS): inject a Redux-store agent, time-travel by
  state-injection — validated in real Chrome.
- **Canvas**: tree mode (nested folder→file→class, collapsible, member click → editor
  reveal) + flat mode (elk class diagram). **Ledger timeline**, **paused scope view**,
  **live project-browser pane**.
- **Replay what-if loop.** A captured checkpoint is a launchpad, not just a record:
  reconstruct the receiver, then re-invoke with **edited tier-1 args / a different
  method / peek-or-destructive mode**, and **diff the outcome against the as-captured
  baseline**. `run.invoke` takes an `argOverrides` map and returns a depth-capped
  `preview` (via `toArray()`/`JsonSerializable`, so Eloquent models & Collections
  render as data). Verified against the real testbed: `projectedLoad(5)→10` replayed
  at `20→40` (Δ +30), peek rolled back; `summary()` re-invoked on the same
  reconstructed receiver returns real Eloquent data.

### Known UX gaps / backlog (found on first real use)

These are polish gaps that accumulated while proving the engine — none are deep.

- ~~**No "open project" UI.**~~ Done — `project.open` re-points the host from the UI.
- ~~**Editor is read-only.**~~ Done — Monaco is editable with Ctrl/Cmd+S save (`fs.write`),
  and runs use the live (possibly unsaved) editor source.
- ~~**StrictMode double-subscribes notifications.**~~ Done — `notificationsBound` guard.
- **Explorer is a flat list, and redundant with the tree canvas.** The left rail is
  a path-sorted list, not an IDE tree; the new tree canvas is the real navigator.
  Reconcile: make the Explorer a proper tree, or fold it into the canvas.
- **Flat-mode canvas inconsistency.** Flat mode swaps member detail by *zoom level*
  (members appear at zoom ≥ 0.7) with **no clickable collapse**, while tree mode uses
  explicit chevrons — so flat mode looks like its "arrows" aren't hooked up (there are
  none). Also, **flat-mode member rows are not clickable** (only double-click the box
  opens the file), whereas tree-mode rows click through to the editor. Make the two
  modes consistent.
- **Right rail reads as one section but is two.** "RUN SLICE" (run controls) and
  "SLICE & SWAPS" (Problem code / Active swaps / Waypoints) are visually merged.
  Separate them and clarify labels: *Problem code* = swap candidates (not warnings);
  *Unit* = run one method in isolation; *Request* = drive a real HTTP route (Postman-
  like) capturing across files.
- **Flat-mode minimap doesn't color group/class nodes.**

### Functional gaps (not yet built)

- ~~**Request-mode replay.**~~ Done — whole-request entries carry base64
  reconstruction blobs that the host decodes before reconstruction, so a captured
  waypoint from a subprocess run replays like a unit one.
- ~~**Interactive breakpoint continue / step.**~~ Done — a subprocess blocks on stdin
  at breakpoints while the host select-loop multiplexes its pauses; continue / step /
  stop drive it live. (Live *variable* edit at a pause is still swap + re-run.)
- ~~**CI.**~~ Done — GitHub Actions runs the PHP, JS, and UI suites on every push.
- **Packaging / distribution.** Still manual: no published binaries/extension; the
  host, JS adapter, and UI are started by hand. The remaining pre-product gap.

---

## 14. Proposed features (backlog — recorded, not yet built)

Four directions to fold in when we get to them. Engineering notes + open questions
for each; the probe (#4) explicitly needs a design conversation before building.

### 14.1 Project-aware API console ("Postman, but it knows your code")

A standard request builder (method / URL / headers / body / auth / saved requests /
history / env vars) — table stakes. The differentiator is that we're *inside the
project*, so the per-language adapter can **introspect the app's routes and
auto-build the collection**, kept in sync as routes change.

- **Laravel:** `php artisan route:list --json` (or the route registrar) yields
  method + URI + name + `controller@action` + middleware + parameters. The adapter
  emits a route-schema; the UI renders a navigable collection that re-introspects on
  demand (or on a routes-file change).
- **The real special sauce:** a request from the collection can be driven *through
  the instrumented runtime* — i.e. it reuses `run.request`, so sending a request
  also captures waypoints, hits breakpoints, and fills the ledger. Postman fused
  with the debugger, not bolted beside it.
- **Adapter contract:** add a `routes() → route schema` slot per language (Laravel:
  route:list; JS: Express route table / Next.js app-router / NestJS metadata).
- **Body/param inference (stretch):** Laravel `FormRequest` validation rules and
  route-model-binding can suggest the request body shape and path params.
- **Open:** how much of full Postman (collections, scripting, assertions) we mirror
  vs. keep lean and lean on the code-integration advantage.

**Locked decisions (build):**
- **Route source:** introspect the host's router (`router->getRoutes()` →
  names/middleware/params/model bindings), not `artisan route:list`. **Done via a
  one-shot fresh boot** (`request-run.php` `routes` entry kind) rather than the
  resident host, so the listing stays in sync with the route files on disk — the
  resident host caches routes from its boot, which went stale on edits. The UI
  auto-refreshes on entering the API tab and via a ↻ button. New adapter slot
  `api.routes`; BareHost/JS return `[]` until a framework introspector exists.
- **Execution target — both, chosen per request.** Default: the **in-process booted
  kernel** (reuse `run.request`/`renderEntry`), which gives capture for free. Optional:
  a **plain external HTTP call** to a base URL, run server-side from the host (no CORS,
  real timing) — *no* capture on external sends (that would need the §14.4 probe).
- **Capture by default.** An in-process send always goes through the instrumented path,
  so whatever waypoints/breakpoints are placed fire and the ledger fills; the console
  is itself a debugging surface, and a captured request flows straight into the replay
  what-if loop.
- **Full Postman parity (staged) — both stages built.** Stage 1 (spine): auto
  route-list collection + request builder (method/URL/query/headers/body json·form·raw/
  auth none·bearer·basic·apikey) + environments with `{{var}}` substitution + dual-target
  send + response view (status/time/size/body/headers) + history + saved requests.
  Stage 2: a `pm.*`-style scripting runtime (`store/pmSandbox.ts`) for **pre-request
  scripts + test assertions** — `pm.environment`/`pm.variables` (mutations persist to
  the env), `pm.test`, a chai-lite `pm.expect`, and `pm.response` — with a pass/fail
  results panel. Not a security sandbox (scripts are the user's own, run in-browser via
  `new Function`, like Postman). Deep Postman corners — OAuth2 flows, cookie jar,
  code-gen — are acknowledged as later.
- **Persistence pulls in §14.2.** Saved requests + environments live in the project
  app-file (`.waypoint/api.json`) so they're shareable — the first concrete consumer of
  the `.waypoint/` store.
- **Request shape enrichment:** `renderEntry` / the `http` entry grow query + headers +
  body + cookies so an in-process send is a faithful request; the response now carries
  real headers + duration.

### 14.2 Project app-file (shareable settings)

A file committed in the project so a team **shares debugging setups**: swap
definitions (mocked lines), waypoints, breakpoints, saved entries/args, run
configs, route-collection tweaks.

- **Shape:** a `.waypoint/` dir — `config.json` (shared, committed) + `local.json`
  (personal, gitignored), mirroring the `.vscode/settings.json` vs `launch.json`
  split. The host reads/writes it (fs.* already exists); the UI loads on project
  open and persists changes.
- **Anchor stability (important):** swaps/waypoints/breakpoints are line-based today,
  which is brittle across edits. For a *persisted, shared* file they should anchor to
  something stabler than a raw line number — e.g. `Class::method` + an
  intra-method marker (nth statement, or a matched code fragment) — so they survive
  edits and other people's line numbers. This is the same fragility we already touch
  with multi-edit instrumentation; the app-file makes solving it worthwhile.

### 14.3 Remote registry (later)

A central store to: update the tool, **install optional modules/adapters** (extra
language adapters, framework-specific route introspectors, community plugins), and
**sync personal settings** across machines.

- The per-language adapter contract already makes adapters packageable — an adapter
  is just a package implementing the JSON-RPC method set. A registry serves adapter
  manifests; the tool fetches/installs.
- Personal-settings sync is account-based (cf. "Sign in with Vercel"-style OAuth):
  store the `local.json`-equivalent remotely.
- Deferred; noted here for shape so we don't preclude it (keep adapters cleanly
  package-shaped, keep settings serializable).

### 14.4 In-project probe (error-triggered state + logs) — NEEDS DISCUSSION

The tool inserts a **probe** into the project (a service provider / middleware /
exception hook) that connects back to Waypoint and, on a detected error, sends the
request context, relevant state, recent queries, and logs.

- **"State before the error" — the practical version:** continuous whole-app
  checkpointing is too expensive, but we already capture at **waypoint boundaries**.
  So keep a small **ring buffer of recent waypoint captures in-app** and, on an
  exception, flush *the last captures before the error* + the error context. The
  probe is essentially the always-on, error-triggered form of our on-demand ledger —
  it reuses Recorder/the capture tier system.
- **Transport:** probe dials out to the Waypoint host (or pushes over the existing
  WS), so it works even when the runner isn't the one serving the request.
- **Self add/remove + safety:** like the docker-runner stanza, the probe is
  installed/removed by the tool; it must be guarded so it never ships to prod
  unguarded (env-gated, explicit opt-in), and scoped in what state it captures.
- **Open questions to settle first:** error-detection hook surface (exception
  handler vs. a wrapper), what state is in-scope to capture (and PII/security),
  push vs. pull, and how the ring-buffer depth trades memory for history.

### 14.5 Outbound HTTP mock (boundary-level), distinct from swaps

Two layers of "mock," not redundant:
- **Swaps (built):** mock at the **code-expression** level — replace a specific line
  (`User::findOrFail($id)`, a `Http::get(...)` call) with a template/fake. Surgical,
  tied to a location you can see.
- **Outbound mock (future):** mock at the **boundary** — fake *any* outbound call
  matching a URL pattern, regardless of call site, including calls buried in vendor
  SDKs you'd never swap line-by-line. The thing swaps can't easily do: the same
  endpoint hit from five places, or a dependency three layers into a package.

Not needed for the core replay/reproducibility story, and **not** an "API intercept"
we build from scratch: for Laravel the framework already provides `Http::fake([...])`,
so this feature would *drive the framework's faking* during a run/replay (consistent
with §5.5 "reuse the framework, don't build a generic recorder"). File as a future
tier-3 reproducibility helper; surface it in the swap workbench as a "mock outbound
calls" option, separate from line swaps.

## 15. Setup & distribution (clone → run → connect)

Goal (stated): clone from GitHub on a fresh Debian/Windows box, **run one file**, then
connect and start using it — minimal manual steps. Today a new user faces three
sub-projects (composer install in `runner/`, npm install in `runner-js/` and `ui/`),
a UI build, and two long-lived processes (host on ws 9778, UI on 5180) started by
hand — too much friction.

**Recommendation — a single Node-based launcher as the primary path, Docker as the
hermetic alternative.** Reasoning:
- **Node CLI launcher (`bin/waypoint.mjs`, run as `node bin/waypoint.mjs up`).** Node
  is already a dependency (UI + JS adapter), so "run a file" needs no new runtime, and
  one script behaves identically on Windows/Linux/macOS (no parallel `setup.sh` +
  `setup.ps1`). It does: **doctor** (check PHP ≥ 8.2, Node, Composer; print precise
  remediation) → **install** (composer + both npm installs, skipped if up to date) →
  **build** (UI) → **up** (spawn the host against a `--project` path, serve the UI,
  open the browser, manage/clean up both processes). Subcommands: `doctor`, `up`,
  `--project <path>`.
- **Docker Compose (`docker compose up`) as the no-local-toolchain option.** Containers
  for the PHP host + UI; the target project is bind-mounted. Hermetic PHP/Node
  versions, truly one command. Trade-off: bind-mounting an arbitrary local project (its
  `vendor/`, its DB/services) and reaching them is fiddlier than the native launcher,
  so it's the secondary path, not the default.

What this is **not**: a heavyweight bespoke "environment framework." Start with the
launcher; the eventual **VS Code extension** (the packaging/distribution gap in §13)
subsumes most of it — the extension bundles and starts the host/adapter and serves the
UI in a webview, so "install the extension, open a project" replaces the script.

Open questions before building: minimum PHP/Node versions to support; whether the
launcher provisions a sample Laravel testbed for first-run (a `waypoint init` demo) vs.
only attaching to an existing project; and whether to ship prebuilt UI assets in the
repo (so `up` skips the build) or always build on first run.

---

*Rationale and the longer discussion that produced these decisions live in `debug-tool-design.md`.*
