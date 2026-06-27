# Visual Checkpoint-Replay Debugger — Design So Far

A record of the design as discussed. Settled decisions, noted tradeoffs, and forks left open are marked as such. Nothing here is added beyond what was covered.

---

## 1. What the tool is

A debugging / code-traversal tool, distinct from a step-through debugger, with this target capability set:

- Run the whole project, or pull out specific pieces and run them in isolation.
- The usual debug affordances: variable tracking, breakpoints, change variables on the fly.
- Mock the input data for a piece and run from there.
- "Move the IP around" — relocate execution to a chosen point.
- A UML class-diagram-style interface where you can start execution at any point, with a convenient data-entry UI.

First target language: **PHP**, aimed specifically at Laravel CRUD systems. **TypeScript / JavaScript** is the planned second language.

---

## 2. Core mechanism — "moving the IP" as checkpoint-and-replay

The IP-relocation feature is realized not as live instruction-pointer movement but as **checkpoint-and-replay** (the same family as time-travel / record-replay debuggers such as `rr`, arrived at independently).

### The ledger model

Execution path example: `A → B → C, D`

- `A` changes to `B` → memory changes saved in **ledger 1**.
- `B` changes to `D` → memory changes saved in **ledger 2**.

To move the IP to a point inside a node:

1. Save current memory state.
2. Restore the relevant ledger (the one whose boundary precedes the target).
3. Run forward from that boundary to the IP target.
4. Depending on the **settings of the IP move**, restore memory from before the move.

Worked cases as specified:

- IP into `D` → restore ledger 2, run to target, then (per setting) restore prior memory.
- IP into `C` → restore ledger 2, run to target, then (per setting) restore prior memory.
- IP into `B` → restore ledger 1, run to target, then (per setting) restore prior memory.

### Two halves of the operation

- **Restoring a ledger to a boundary is free** — it applies recorded state, executes nothing, so it has no side effects.
- **Running from the boundary to an arbitrary line *inside* a node executes** — and re-fires whatever that span does.

The "settings of the IP move" distinguish:
- **Destructive** — land at the target on the reconstituted state and continue.
- **Peek** — reconstitute, observe, snap back to where you were paused.

### Determinism cost — scoped to the replay sub-segment

The determinism problem is confined to the **boundary → target** sub-segment (the part that must execute, not the part that's restored). For pure in-memory mutation, replay is harmless and exact. For Laravel CRUD, the span often contains `$model->save()`, so a relocation crossing a save re-issues the INSERT/UPDATE; anything in the span reading `now()`, a random token, or an autoincrement id diverges on replay.

Two allies for this:
- **Wrap the replay span in a DB transaction and roll it back after landing.** Re-fired saves hit the connection then vanish — peek-mode and rollback are the same gesture.
- **Record-and-pin non-deterministic reads** — capture each non-deterministic read on the first run, feed the recorded value back on replay. For a CRUD slice the pin-set is usually small.

### Ledger capture / restore cost in PHP

- **Easy:** plain scalars and arrays — snapshot the symbol table at each boundary (Xdebug can dump scope, or you instrument it).
- **Sharp edge:** non-serializable things — an open PDO connection, a file handle, a curl resource. A ledger can record that they existed but cannot reconstitute them. Laravel objects hold references back into the service container and the live connection, so "restore the object graph" can pull in more than intended.
- The live-state surface is **small for a narrow slice** (load model, mutate fields, save) and **grows fast** once a span touches the container, events, or queued jobs.

---

## 3. Input / data mocking

### Mechanism — code swapping

Temporary code swapping at the call site. Example:

```php
$user = User::find(1);
```

swapped for

```php
$user = ["email" => "person@email.com" /* ... */];
```

plus **templating** for things like Eloquent.

### Literal vs template — decided per site by consumption

The correctness rule: the fill must satisfy **what the span does to the variable downstream**, not what the original call returned.

- Array literal holds as long as the span only touches the variable via array access (`$user['email']`).
- The moment the span does `$user->email`, `$user->save()`, or `$user->posts`, the literal breaks → template.
- Per-site rule: scan what the span does to the variable, emit the lightest shape that satisfies it. Array reads → literal; anything object-ish → template.

### Eloquent as the template engine

Real hydration handed a data template returns a model that behaves correctly:

- `User::make([...])` / `(new User)->forceFill([...])` → `exists = false` (a record about to be created).
- `(new User)->newFromBuilder([...])` → `exists = true` (the method Eloquent uses internally to hydrate a row from a query result).

The `exists` flag bites in CRUD: a later `->save()` is an UPDATE when `exists = true`, an INSERT when `false`. For "a record that was supposedly loaded," `newFromBuilder` is the default — indistinguishable from a fetched row, with casts / accessors / mutators live.

**Relationships** are recursive: `$user->posts` still lazy-loads from the DB even on a hydrated fake unless pre-seeded with `$user->setRelation('posts', collect([...]))`. So the template is an object graph — bounded by the same scoping as the replay span: only the relations the span actually traverses need seeding.

### Swap mechanics

- **Indirection over baked-in literals.** `$user = $__swaps['user_1'] ?? User::find(1)` keeps the swapped source static and lets the UI just write the map — composes with a form more directly than literal substitution.
- **AST-based swap over string matching.** Using nikic/php-parser (locate the assignment node, replace its RHS) is sturdier; the swap can ride the same AST already being parsed for the class-diagram surface.

### Arbitrary code in the hole

The swap site is an **expression hole**, not a value hole — literal and template are two points in an unbounded space. Legal fills include a closure, a factory, a real `User::find(1)` with relations stripped, or "load for real then override three fields." The slot only has to evaluate to something the span can consume.

Consequences:
- The static shape analysis becomes a **suggester**, not a gate — opt-in rather than automatic.
- The correctness obligation **moves, not removes**: the span still consumes the variable in fixed ways, so "the fill must satisfy what the span does to it" survives — it just becomes the author's call.
- An expression hole is also a **side-effect hole.** A pure fill (literal, hydrate) is inert; a fill that does I/O (DB, `now()`, an API call) re-opens the determinism question at *setup* time, not just in the replayed segment.
- The data-entry panel therefore emits an **expression**, not a typed value — the form is a small code surface with affordances.

**Open fork:** how far the UI leans toward typed-value entry for the common case vs. opens to free expression for the rest.

---

## 4. Runner-as-host

The tool **is the runtime**; Laravel is just what it executes. The PHP that boots Laravel and the PHP that is the tool are the **same process** — one host that happens to run framework code. This dissolves the need for a separate PHP-for-Laravel arrangement.

- The pause/capture machinery a DBGp-attach would have bought is **relocated, not deleted**. Owning the runner means you instrument the boundaries yourself — and since the source is already being AST-rewritten for swaps, the checkpoint hooks ride the same pass. The same tree-walk that replaces `User::find(1)` injects `__capture(__LINE__, get_defined_vars())` at boundaries. One instrumentation pass, two payloads. (Xdebug can still be loaded into your own process for its scope-dump if you'd rather not build capture — now a convenience inside your process, not a wire across to a foreign one.)
- **Input-mocking and replay-determinism are one surface.** A replay span re-firing `$model->save()` is an outbound live call; the mock-replace-live-calls system *is* the fix. The same interception that fakes inputs coming in neutralizes side effects going out.

This reframe also moved the language coordinate (see §6): the central fact becomes a persistent PHP process hosting Laravel + instrumentation + serving, which is PHP-host territory, shrinking the JS side toward "build the UI."

---

## 5. Docker mode

For dockerized projects, the runner **lifts out of the container set**: it runs the same host process (Octane/Swoole + instrumentation) while the rest of the compose stack stays up around it.

### The mock dial gains a second end

A swapped call resolves to **fake data** *or* falls through to the **real dockerized service**. Same interception point, target swapped — `User::find(1)` becomes a literal, or a real query against the mysql container. One surface, two destinations, chosen per site. "Docker-backing" and "data-mocking" are the same dial at different levels: pointing a connection at a host-mapped port is mocking *where* a dependency lives instead of *what* it returns.

### Reaching the dependencies — the seam

The runner is now outside the compose network, so how it reaches deps matters:

- **Published ports** ("external ports") work *when the dep publishes one*. Dev compose files often map e.g. `3306:3306`. But many publish only the web port and leave db/redis reachable internally by service name with no host mapping — then a host-side runner has nothing to connect to. This path needs a `DB_HOST → 127.0.0.1` + mapped-port override.
- **Join the compose network** (more robust) — run the runner as a container on that network, or `docker network connect` the project network to it. Then it reaches deps by service name (`mysql:3306`) exactly as the real app container would, and the app's own `.env`/config needs almost no rewriting (`DB_HOST=mysql` stands).

### nginx / php-fpm fall away

A normal compose routes nginx → php-fpm. Since Octane serves HTTP directly, the runner replaces **both** for the path it drives — it is the entry point, not a proxy into a php-fpm container. (Reaching back to the host via `host.docker.internal` is only needed if some container must call the PHP; Octane-direct mostly removes that need.)

### Two determinism postures

- **Mock mode** — a crossed `->save()` on replay hits a fake; side effects neutralized.
- **Docker mode** — that save is real, against the live mysql container; the transaction-wrap-and-rollback guard covers this live path while mock mode sidesteps it.

This is a feature: "I want the real DB but don't want replay to mutate it" is precisely transaction-rollback.

### Which service is "the PHP runner"

- It's often **plural** — `queue`, `scheduler`, sometimes `horizon` are all PHP. "Replace the PHP service" may mean subsuming several; you choose which to take over vs. leave containerized. (Choosing which you replace is a confirmed part of the design.)
- Identifying the PHP service is a **heuristic** (build context, image, the one running artisan) that misfires on custom setups — so let the user mark it in the UI rather than always auto-detecting.

### Mechanics

- **Self add/remove:** the runner knows how to add and remove itself from a docker setup (the files involved are simple).
- **Read-only path:** parse the compose file, enumerate services, bring up the non-runner set (`docker compose up -d <those>`, which pulls their `depends_on`), read the port mappings or network name, point the runner in. No mutation of their compose — unless the unpublished-dep case is hit, which forks back to network-join.

---

## 6. Language strategy & the general interface

The tool is **polyglot before any language is picked**. Two pieces are fixed by constraints:

- **An agent inside the debuggee** — boots the app, holds the debug-protocol side, does the AST swap. For PHP this is PHP (nikic/php-parser, the round-trip-fidelity parser-printer, is itself PHP).
- **A UI** — the class-diagram canvas + the expression-emitting entry surface — is web tech (canvas/SVG + browser), i.e. HTML/JS/TS regardless.

So a PHP component and a JS/TS component exist no matter what. The remaining choice was the **core** in the middle (the long-running thing holding the ledger, speaking the debug protocol, coordinating swaps, serving the UI).

**Where it landed:** the runner-as-host reframe (§4) plus the one-app decision (§7) pushed this toward a **PHP-hosted runner with a TS/React UI in a single app**, rather than two separate apps or a separate coordinator language. (Earlier in the discussion a Node/TS core with a thin PHP agent was weighted on the grounds that async coordination is Node-native and the JS phase pays it forward; the runner-as-host model shifted the weight back toward the PHP-host / one-app instinct.) The candidate that was set aside — a Go/Rust core — would give the best standalone daemon but adds a third language with no native PHP/TS AST story.

### The per-language contract ("very general interface")

Most of the system is **shared / language-neutral, written once:**
- Docker orchestration (compose is compose — parse, subset-up, network-join, add/remove the runner).
- UI (React Flow renders a generic node graph; the code pane shows generic source; the iframe shows generic HTTP output).
- The core coordinator.
- Ledger *orchestration* — which checkpoint, replay-to-target, peek-vs-destructive.

**Per-language adapter** satisfies this contract:
- `parse(source) → structure model` — the "interpreter level for the diagrams"; per-language in, common schema out.
- `instrument(ast, swaps, boundaries) → source` — swaps + capture hooks, round-trip-faithful.
- `host / run` — boot the app, drive an entry, serve.
- `capture(boundary) → blob` / `restore(blob)` — the ledger primitive.
- `transport` — pause / scope / resume / step (the "connection to chrome").
- `resolve(swap-site) → fake | real` — the mock dial.

### The two seams where "general" is earned

- The **structure model** both parsers emit into must be language-neutral.
- The **state blob must be opaque to the core** — the core stores it and hands it back, never reads inside it. The moment the core introspects the blob, it stops being general.

### Three coordinates on per-language divergence

- **Transport asymmetry, in your favor.** CDP (Chrome) is richer than DBGp (PHP) — it can inspect scope and steer execution in ways DBGp can't. The interface defines the *capability* ("capture state at boundary"), not the *mechanism*: PHP satisfies it with AST-injected hooks, JS through the protocol itself. Same slot, different fill.
- **The async seam.** PHP's request is synchronous — a boundary is a clean point on a linear line and capture is "the symbol table here." JS runs on an event loop, so "the state at line X" can ride on pending promises and microtask ordering; the blob may have to carry continuation state, and replay-to-target inherits an ordering question. The contract slot is identical; what the JS adapter must *put into* the blob is the heavy part. ("JS's capture is the hard slot," not "JS is hard.")
- **Class-density.** Laravel is class-dense, so "class diagram" sits cleanly. JS leans on functions, modules, prototypes — plenty that isn't class-shaped. So the structure schema wants **node-kinds** (class / function / module / method) from day one, even though PHP only exercises the class kind at launch.

---

## 7. Front end

- **Split screen.** Left: the diagram + code surface you navigate and interact with. Right: a "browser" to the project. (Not required at launch but designed for early.)
- **Canvas:** React Flow (`@xyflow/react`) for "UML nodes you bind things to" — each class a custom node, fields/methods as rows with handles, where the handles *are* the binding affordance (wire a node to an entry point, a swap, the ledger). Paired with **elkjs** or **dagre** for auto-layout, so it looks arranged rather than free-roaming — laid-out class diagrams, not a hand-placed scatter. (Doesn't need to be free-roaming, but should look nice with options to bind to various things.)
- **Code pane (left):** Monaco (renders swap-highlights and inline widgets in the source) or CodeMirror 6 if lighter.
- **Project browser (right):** renders the **real Laravel response** the runner produces — which is what lets the tool test the FE (actual output, not a mock of it).
- **Owned surface vs iframe.** The right pane is *owned* — the framework feeds it whatever state it wants. If it is an iframe, it can be redirected to a different location with any state.
  - iframe + postMessage + injected hydration state is the **more isolated** option (separate document and JS context; the app can't corrupt the debugger's context); cost is the postMessage boundary.
  - An owned non-iframe mount is **more direct** but couples the debugger's JS context to the app's.
- **One app.** The split-screen / project-browser realization led to the conclusion that this is **both TS and PHP in one app**, not two separate ones. React + TypeScript ties the front end together (Svelte + Svelte Flow noted as the same canvas family with less ceremony, if preferred).

---

## 8. JavaScript / TypeScript phase specifics

Substrate notes for the second language.

### "Multiple IPs?" — no; one live IP, a fragmented timeline

- At a pause, CDP gives **one synchronous call stack** (`Debugger.paused` → one `callFrames` array; V8 is single-threaded per isolate), plus a **separate async stack trace**.
- The async stack trace is **reconstructed history, not live frames** — it shows where the async operation was initiated, but those frames have already returned. It's walk-back-and-inspect, not land-and-resume.
- The plural thing is **segments, not IPs.** One logical flow (`main` awaits `getUser` awaits `fetch`) is physically three event-loop turns; each `await` fully unwinds the stack and builds a fresh one on resume. One IP, hopping between disconnected stack contexts.

Effects on the ledger:
- **await points force some boundaries on you** — each suspend/resume is already a natural checkpoint site (the event loop hands them over for free).
- **Replay-to-target goes async** — if the boundary→target span contains an `await`, you can't run straight through it; you re-enter the event loop and wait for the continuation.
- **The capture blob at an await = symbol table + pending promise + continuation.** The async stack trace shows a read-only view of that chain but doesn't hand it over as a restorable object. (Frame identifiers are only valid while paused, so the blob must capture content, not frame ids.)

The ally: CDP already solved "follow one logical thread across the event-loop gaps" for stepping — `setAsyncCallStackDepth`, `stackTraceId` stitching, and pause-when-async-call-starts. That stitching is the primitive replay-to-target rides.

A flag: CDP's in-place editing is tightly bounded — live source edits fail for functions currently on the stack, except the top-most frame as its only activation (which auto-triggers a `restartFrame`). So CDP gives "restart the top frame from its start," not "move the IP to an arbitrary line." The **ledger-replay approach remains the thing doing arbitrary relocation on the JS side**; CDP supplies richer capture and the cross-gap stitching underneath. (Recency note, held loosely: a 2026 source reports Chrome 145 deprecated live JS editing in favor of workspace/HMR — worth verifying against the official protocol changelog before relying on `setScriptSource`; the swap path is mostly pre-run and may sidestep it.)

### FE state — the browser gives the *read* free, not the *save*

- "Save" = read + serialize + persist; "restore" = reconstruct + write back. The protocol shortcuts the **read** and leaves the rest to you.
- **Free read:** where PHP needed an AST-injected `__capture(get_defined_vars())` to see boundary state, JS instruments nothing. At a pause the inspector already exposes scope — `Debugger.paused` carries each frame's scope chain; `Runtime.getProperties` and `Debugger.evaluateOnCallFrame` walk any variable/object in any frame; `Debugger.setVariableValue` writes one back. "What's the state here" is a question you ask, not hooks you build.
- **Not handed to you:** any "snapshot the whole execution state to a restorable blob" command. V8's inspector has no reverse-execution and no whole-VM serialize/reload. Turning the read into a persistable blob and reconstituting a live context is yours — and it hits the same non-serializable wall the moment state holds a DOM node, a socket, or a closure over a closure.

### The framework-state escape

Letting **the framework feed the browser whatever state it wants** moves capture from the **VM-execution level** (continuation state, microtask ordering, live objects — the hard level) to the **framework-state level** (a Redux store, a Vue reactive tree, a signals graph — already plain serializable data by design, because frameworks need it that way for SSR hydration, HMR-with-state-preservation, and their own devtools).

- At the framework-state level, JS capture becomes the **easy** slot — easier than PHP, where Laravel state lives in live objects that must be snapshotted, vs. framework state arriving as plain data already serialized.
- **Redux DevTools already is this ledger** — it snapshots the state tree on every action and replays to any point. Framework-level time-travel is shipped, mature; it's absorbed as the FE fill for the ledger slot rather than reinvented.
- This **collapses the replay worry on the FE side**: FE ledger entries become framework-state snapshots (the store at action N), not VM blobs. "Run to the IP target across awaits" mostly evaporates — you're no longer replaying execution to reach a state, you're **dispatching the state** into the framework and letting it re-render. **State-injection, not execution-replay.**

---

## Open forks (collected)

- **Data-entry UI:** typed-value entry for the common case vs. free-expression surface for the rest.
- **Docker dep reach:** published-ports (simple, needs host/port override, fails on unpublished deps) vs. network-join (robust, near-zero config rewrite).
- **Right-pane surface:** owned non-iframe mount (direct, coupled) vs. iframe + postMessage + injected state (isolated, postMessage boundary).
- **Core language final lock:** landed toward PHP-host / one-app; the pull back toward a PHP core over an earlier Node-core lean was the AST-swap-fidelity argument (living in nikic/php-parser's house vs. shelling into it).
