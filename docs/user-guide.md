# Waypoint — User Guide

Waypoint is a visual debugger and code-explorer for **PHP/Laravel** and **JavaScript/TypeScript**. Instead of stepping line by line, you mark points in your code, run it for real, and capture the exact state at each mark — then **re-run any method from that captured state**, change inputs, and see what happens, with database writes rolled back by default.

This guide documents every feature, setting, and workflow. It is organized so you can read top-to-bottom to learn the tool, or jump to a section for a specific task.

---

## Contents

1. [Install & start](#1-install--start)
2. [Open a project](#2-open-a-project)
3. [The workbench](#3-the-workbench)
4. [Navigate your code](#4-navigate-your-code)
5. [The code editor](#5-the-code-editor)
6. [The integrated terminal](#6-the-integrated-terminal)
7. [Run & debug](#7-run--debug)
8. [Capture & replay](#8-capture--replay)
9. [Mock side-effects (Swaps)](#9-mock-side-effects-swaps)
10. [Routes](#10-routes)
11. [API console](#11-api-console)
12. [Data console](#12-data-console)
13. [Search & replace](#13-search--replace)
14. [Front-end + back-end debugging](#14-front-end--back-end-debugging)
15. [Remote error capture (Probe)](#15-remote-error-capture-probe)
16. [Docker mode](#16-docker-mode)
17. [Save your work (markers & sessions)](#17-save-your-work-markers--sessions)
18. [Project settings](#18-project-settings)
19. [Manage projects](#19-manage-projects)
20. [Configuration & files reference](#20-configuration--files-reference)
21. [Keyboard shortcuts](#21-keyboard-shortcuts)
22. [Known limitations](#22-known-limitations)

---

## 1. Install & start

### Requirements

| Tool | Minimum | Required |
|---|---|---|
| Node.js (+ npm) | 18 | Yes |
| PHP | 8.2 | Yes (for PHP projects) |
| Composer | any | Yes (for PHP projects) |
| PHP extensions: curl, mbstring, pdo | — | Recommended |

### Start everything with one command

From the Waypoint repo root:

```bash
node waypoint.mjs up --project /path/to/your/app
```

This checks prerequisites, installs dependencies the first time, and starts the backend, the terminal server, and the web UI, then opens your browser at `http://localhost:5180`. Press **Ctrl-C** to stop everything.

If you run `up` with no `--project`, it opens a small **bundled sample project**, not your app.

### Launcher commands

| Command | What it does |
|---|---|
| `node waypoint.mjs up` | Install if needed, then start the backend + terminal + UI (default command). |
| `node waypoint.mjs doctor` | Check prerequisites only. |
| `node waypoint.mjs install` | Install backend + UI dependencies. |
| `node waypoint.mjs modules` | List the supported languages and frameworks. |
| `node waypoint.mjs help` (or `--help`, `-h`) | Show usage. |

### Launcher options (for `up`)

| Option | Default | Effect |
|---|---|---|
| `--project PATH` | bundled sample | The app to debug (also accepted as a bare path: `up /path`). |
| `--language ID` | `php` | Backend language (`php` or `js`). |
| `--frontend [ID]` | auto | Also start a front-end runner (automatic when the project has a `package.json`). |
| `--no-frontend` | — | Never start the front-end runner. |
| `--terminal` | off | Start the integrated bash terminal server (opt-in; a web-reachable shell is off by default). |
| `--build` | dev server | Serve a production build of the UI instead of the dev server. |
| `--no-open` | opens browser | Don't auto-open the browser. |
| `--force` | — | Reinstall dependencies even if already present. |
| `--ws-port N` | `9778` | Backend control-plane port. |
| `--http-port N` | `9777` | Backend analysis-only fallback port (PHP). |
| `--ui-port N` | `5180` | Web UI port. |
| `--pty-port N` | `9790` | Terminal server port. |

Example:

```bash
node waypoint.mjs up --project /var/www/app --ui-port 3000 --no-frontend
```

> **Alternative launcher:** `./dev.sh /path/to/app` is a minimal bash launcher (no prerequisite check, no options). Prefer `node waypoint.mjs up`.

### Live vs. analysis-only

- **Live mode** — Waypoint boots your app and keeps it running, so you can run code, capture state, replay, query the database, and use the API/Data consoles. This is the normal mode.
- **Analysis-only mode** — if your app can't boot on this machine (for example a PHP 8.4 app on a PHP 8.3 host), Waypoint still gives you code navigation, structure, search, and route listing (via Docker), but not live run/replay. The status chip in the top bar tells you which mode you're in.

---

## 2. Open a project

You can point Waypoint at a project three ways:

1. **At launch** — `--project PATH`.
2. **From the top bar** — click the **project button** (📁 with the project name) next to the logo, then:
   - pick a project from the list, or
   - click **“+ Open folder…”**, type an absolute path, and press **Enter**.
3. Projects you've opened are remembered in a per-machine list (the **project switcher**).

Switching projects fully resets the workspace (open files, markers, captures, sessions). Remove a project from the list with the **×** next to it (this only forgets it; it does not delete files).

If a project looks unconfigured, a **provisioning banner** appears under the top bar with one-click, opt-in setup actions (Install dependencies, Create `.env`, Run migrations, Bring up Docker). Nothing runs until you click it. Dismiss with **×**.

---

## 3. The workbench

### Top bar (left to right)

- **Logo / “Waypoint”** — brand mark.
- **Project button** — the project switcher (Section 2).
- **View tabs** — switch the main area between views:

  | Tab | Opens |
  |---|---|
  | **Class diagram** | The **Code Navigator** (Section 4) |
  | **Code** | The code editor (Section 5) |
  | **Search** | Project search & replace (Section 13) |
  | **Routes** | The route map (Section 10) |
  | **API** | The API console (Section 11) |
  | **Data** | The Data console (Section 12) |
  | **Probe** | Remote error capture (Section 15) |

- **Placing toggle** (Code view only, with a file open) — chooses whether clicking the editor gutter places a **breakpoint** or a **waypoint** (Section 8).
- **Terminal** button — show/hide the integrated terminal (Section 6).
- **Run / Stop** button — enters/leaves “running” layout, which splits in a live preview of your app and a bottom inspector. (This is the layout switch; the buttons that actually execute code live in the right-side **Run** panel.)
- **Runner chips** — one per connected engine, showing language and role (backend / frontend).
- **Status chip** — connection + mode (e.g. `host: php (ws)`, `php 8.3 · static`, or `runner offline`).
- **Settings gear** — open **Project settings** (Section 18).

### Layout in Code / Class-diagram views

- **Left rail** — the **File Explorer**.
- **Center** — the Navigator or the code editor (plus the terminal if open).
- **Right rail** — three panels: **Run**, **Swaps & waypoints**, **Saved sessions**.
- **Live preview + bottom inspector** appear when you press **Run** (running layout) or whenever a front-end engine is connected.

---

## 4. Navigate your code

### Code Navigator (the “Class diagram” tab)

A keyboard-driven, column-based map that drills **folder → file → class → method**. Each item is a card; columns are depth, and the path you've drilled is highlighted as a connected spine. Multiple branches can be open at once.

**Mouse:**
- Click a folder/class to expand it; click a method to open it in the editor at that line.

**Keyboard (when the navigator is focused):**
- **↑ / ↓** — move between siblings.
- **→** — expand / step into the first child (or open, on a leaf).
- **←** — collapse / step to the parent.
- **Enter** or **Space** — expand a branch or open a leaf.
- **Type letters** — jump to the sibling whose name starts with what you type.

**Viewport modes** (top-left of the navigator):
- **Scroll** (default) — fixed zoom; the view follows your selection.
- **Fit** — keeps the whole open tree in view.

### File Explorer (left rail)

A standard collapsible file tree. Click a folder row to expand/collapse, click a file to open it. It shows **every** file (code, configs, markdown, images, route files), not just classes.

---

## 5. The code editor

Opening a file shows it in the editor (powered by Monaco, the same engine as VS Code).

### Tabs

- Opening a file uses a single **preview tab** (italic title) that is reused as you open other files.
- **Pin a tab** so it stays open: click the dot at its left, or double-click the tab. A filled dot = pinned.
- Click a tab to focus it; click **×** to close it.
- **Unsaved edits are kept per tab** — switching tabs won't lose your changes.

### Saving

The editor bar shows the file path and a **dot** when there are unsaved changes. Save with the **Save** button or **Ctrl/Cmd-S**. (For PHP files, saving re-scans structure and side-effect calls.)

### Gutter markers

Click the gutter (left of the line numbers) to place a marker. The **placing toggle** in the top bar decides which:
- **Breakpoint** — pauses execution there (any line).
- **Waypoint** — a capture point; only valid on **public method** lines (those lines are subtly highlighted). See Section 8.

The editor also highlights **side-effect calls** (database, time, randomness, HTTP, filesystem, etc.) inline — these are the calls you can mock (Section 9).

### Non-code files

- **Images** open in an image viewer.
- **Config / markdown / JSON / route files** open as text with syntax highlighting by file type.

---

## 6. The integrated terminal

Click **Terminal** in the top bar to open a real bash terminal docked at the bottom of the Code view, already in your project's directory. Close it with the **×** in its bar, or the Terminal button again.

The terminal server is **off by default** — a web-reachable shell is opt-in. Start it by launching with `--terminal`:

```bash
node waypoint.mjs up --project /path/to/app --terminal
```

or run the server directly:

```bash
npm --prefix runner-js run terminal
```

`bash` is only spawned when you actually open the terminal panel — never at startup, and never automatically.

---

## 7. Run & debug

Running code is driven from the **Run** panel (right rail). It has two modes.

### Unit run — run one method in isolation

1. Open a class file.
2. In the Run panel, pick **Unit**.
3. Choose the **entry** method (defaults to the first public method).
4. Enter **args** as a JSON array, e.g. `[1, "hello"]`.
5. Click **Run slice**.

The method runs on its own with your current (even unsaved) editor content. Any waypoints, breakpoints, and swaps in the file apply. The result appears below; database writes are rolled back by default.

> Unit run works best on self-contained classes. A class that **extends a framework base** (an Eloquent model, a Laravel controller) may not run in isolation — use a **Request run** for those.

### Request run — drive a real HTTP request

1. Place at least one **waypoint** (in any file the request will touch).
2. In the Run panel, pick **Request**.
3. Choose the HTTP **method** and enter the **URI** (e.g. `/checkout`).
4. Click **Run request**.

This sends a real request through your app in a fresh process, capturing at every waypoint across **all** files the request flows through (controller → service → model). The response renders in the live preview.

### Interactive debugger (step / pause)

In Unit mode, click **Debug** instead of Run slice. Execution pauses at your breakpoints and you get:
- **Continue** — run to the next breakpoint.
- **Step** — advance one line.
- **Stop** — end the session.
- A **scope table** of local variables at the paused line.

### Change a variable on the fly

When a Unit run pauses at a breakpoint, simple (scalar) locals in the scope table are **editable**. Edit one or more, then click **Apply & continue** — Waypoint re-runs the slice with your edited values injected at that line and runs to the end. This lets you ask “what if this value were different?” without editing code.

---

## 8. Capture & replay

This is Waypoint's core idea: capture real state, then re-run from it.

### Waypoints (capture points)

A **waypoint** captures the receiver (`$this`) and arguments every time a **public method** is entered. Place one by selecting **waypoint** in the placing toggle and clicking the gutter on a public-method line. (Only public, non-static methods with a body are eligible; eligible lines are highlighted.)

Run a Unit or Request run, and each waypoint crossing is recorded.

### The Capture Log

Captured states appear in the **Variables** tab of the bottom inspector (labeled “Captured state”). Each entry shows the method (`Class::method`), the receiver type, and argument types. Entries stream in live as the run executes.

Some captures can't be reliably reproduced (they hold things like open connections, file handles, or closures). Those are flagged **not reproducible** and can't be replayed — but you can still inspect them.

### Replay / what-if

Click **replay** on a Capture Log entry to open the replay panel. It rebuilds that exact receiver and arguments, then re-enters the method. You can:

- **Change the inputs** — editable arguments accept any JSON value; locked ones are kept as captured.
- **Choose how writes behave:**
  - **Peek** (default) — runs inside a transaction and **rolls back**. Safe; nothing persists.
  - **Commit (destructive)** — **commits** the transaction; writes persist. Use deliberately.
- Click **Run**. The result is shown with a **diff against the originally captured outcome**, so you can see exactly what your change did.

---

## 9. Mock side-effects (Swaps)

The **Swaps & waypoints** panel (right rail) lets you replace real I/O calls with fake values so a method runs in isolation and deterministically.

### Mock a flagged call

1. The panel lists **side-effect calls** found in the open file (database reads, `now()`/random, HTTP, filesystem, mail, cache, queue, events, logging, `env`, `config`), each with a category and line.
2. Click **swap** on a call. Waypoint proposes a sensible fake (for example, a hydrated Eloquent model for a `find()`, or a fixed timestamp for `now()`).
3. Edit the replacement expression — it can be any code, from a literal to a full Eloquent template — then click **add swap**.
4. The swap appears under **Active swaps**; remove it with **×**.

Use **preview rewrite** to see the rewritten source size without running.

> A swap can use **form-driven** substitution (the source stays unchanged and your value is supplied at runtime) or a **hard replace** of the line. Both follow your edits, so they stay on the right line as the file changes.

### Mock outbound HTTP (any call)

To fake **any** outbound HTTP call — even one buried in a third-party SDK — use **Outbound mocks** in Project settings (Section 18). Each rule matches a URL pattern (e.g. `api.stripe.com/*`) and returns a canned status + body. These apply to every instrumented run.

---

## 10. Routes

The **Routes** view lists your app's HTTP routes — method, URL, name, the `Controller@method` it calls, and middleware.

- **Filter** with the search box (by URL, name, action, or method).
- **Refresh** (↻) re-reads the routes.
- **Click a route** to jump straight to its controller method in the editor.

Routes come from booting your app. If your app can't boot on this host but runs in Docker, Waypoint reads the routes from inside the container automatically (see Section 16).

---

## 11. API console

A Postman-style console that is aware of your project. Requests and environments are saved to your project so a team can share them.

### Send a request

1. Choose the HTTP **method** and enter a **URL** (a bare path like `/users`, or `{{base}}/users` using an environment variable).
2. Pick a **target**:
   - **In-process** — runs through your instrumented app, so any waypoints/breakpoints fire and the call is added to the Capture Log for replay.
   - **External** — a plain HTTP call to a running server.
3. Click **Send**.

### Request details (tabs)

- **Params / Headers** — key/value editors (toggle each row on/off).
- **Body** — `none`, `JSON`, `form`, or `raw` (Content-Type is set for you).
- **Auth** — `None`, `Bearer` token, `Basic`, or `API key` (header or query). Values can use `{{variables}}`.
- **Pre-request** — a script (Postman-style `pm.*`) run before sending; can set variables.
- **Tests** — a script run on the response; assertions show pass/fail, and you can save values (e.g. capture a login token into a variable).

### Collection & environments (sidebar)

- **Environments** — select one, edit its variables (used as `{{key}}`), or add a new one.
- **Routes / Saved** tabs — load a request from your route list or your saved requests; **Save** keeps the current request; **×** deletes a saved one.
- **History** — your recent sends.

### Response

Status, time, and size; a **captured** badge when sent in-process; tabs for **Body** (with a pretty-print toggle), **Headers**, and **Tests**.

---

## 12. Data console

The **Data** view is a safe, visual way to browse and query your Eloquent models (think of it as a guarded `tinker` scoped to your models). It runs real Eloquent in your booted app. *(Available for Laravel projects.)*

### Browse models

- The sidebar lists models found under `app/`, with row counts. Filter with the search box; **↻** reloads.
- Select a model to see tabs:
  - **Grid** — a paginated data table (50 rows per page).
  - **Source** — the model's file (read-only).
  - **Relationships** — declared relations; click a related model to jump to it.
  - **Alter model** — edit `$table`, `$fillable`, and `$casts`; **Save model** writes the change back (format-preserving).

### Migrations

**Migrate** shows `migrate:status`; click again to run `migrate --force`.

### Query console

At the bottom, type an Eloquent/PHP expression (e.g. `User::where('active', true)->first()`) and press **Enter**. You'll see the result, the **SQL it ran** (with bindings and timing), and the type.

- The **peek / commit** toggle controls writes: **peek** rolls back (safe, the default), **commit** persists.
- On a result that is a single record, click **→ ledger** to capture it into the Capture Log so you can **replay** a method against that exact row.

---

## 13. Search & replace

The **Search** view searches the whole project.

1. Type a query; toggle **Aa** (match case) and **.\*** (regular expression) as needed; press **Enter** or **Search**.
2. Results are grouped by file; click any match to jump to that line in the editor.
3. To replace, type a replacement and click **Replace all** — then **Confirm** (replace writes files immediately). The open file is refreshed afterward.

Results are capped at 2000 matches; binary and very large files are skipped.

---

## 14. Front-end + back-end debugging

Waypoint can debug a **PHP backend and a JavaScript front-end together**.

### The runners

- The PHP engine is the **backend**; a JavaScript engine is the **frontend**. The launcher starts the front-end engine automatically when your project has a `package.json` (or with `--frontend`). Both appear as chips in the top bar.
- When a front-end engine is connected, the bottom inspector gains **Network** and **State** tabs.

### Attach to your browser

1. Start Chrome with remote debugging: `chrome --remote-debugging-port=9222`.
2. In the inspector's **Network** tab, enter the debug URL (default `http://localhost:9222`) and click **Attach**.

### Inspect network calls

The **Network** tab lists the page's requests (method, endpoint, type, status, time). By default it shows API traffic (XHR/Fetch); tick **all** to include assets. **Detach** stops it.

### Capture front-end state

In the **State** tab, click **Snapshot store** to capture your app's state store (Redux-style) and its action history. You can scrub the recorded actions and restore any earlier state — the framework re-renders from the injected state. (Requires a Redux-style store on the page.)

### Trace a front-end call to its backend

In the **Network** tab, click **→ trace** on a request row. Waypoint re-sends that exact request (body and key headers included) through your instrumented backend, captures the backend trace, and links it to the row — so you can follow one call from the browser all the way through your server code.

---

## 15. Remote error capture (Probe)

The **Probe** lets you pull errors and logs from a **running app** (development, staging, or production) and re-run a failing request through your instrumented backend. It has two parts: a small package you add to your app, and the **Probe** view in Waypoint.

### Install the package in your app

1. In your Laravel app: `composer require waypoint/probe`.
2. (Optional) publish the config: `php artisan vendor:publish --tag=waypoint-probe`.
3. **Turn it on** by setting two values in your app's `.env`:
   ```
   WAYPOINT_PROBE_ENABLED=true
   WAYPOINT_PROBE_SECRET=<a long random string>
   ```
   The probe does nothing until **both** are set (fail-closed). It then exposes one authenticated endpoint (default path `_waypoint/probe`).

### Probe settings (`config/waypoint-probe.php`)

| Setting | Default | Effect |
|---|---|---|
| `enabled` | `false` | Master on/off (must be on, with a secret, to do anything). |
| `secret` | `null` | Shared secret for authentication. |
| `path` | `_waypoint/probe` | The endpoint URL. Make it hard to guess. |
| `allow_ips` | any | Comma-separated IP allowlist. |
| `buffer.driver` | `cache` | Where records are stored: `cache` or `file`. |
| `buffer.max` | `200` | Maximum records kept (oldest dropped). |
| `buffer.ttl` | `3600`s | Records older than this are dropped on read. |
| `capture.exceptions` | `true` | Capture reported exceptions. |
| `capture.logs` | `true` | Capture log events… |
| `capture.log_level` | `error` | …at or above this level. |
| `redact` | common secret keys | Field names (substring match) scrubbed from captured data. |
| `ring_buffer` | `false` | Collect a per-request “breadcrumb” trail (queries + logs) leading to an error — heavier; toggle it remotely from Waypoint. |
| `triggers` | all | Only attach breadcrumbs for these exception classes. |

The probe is safe for production: it stores at most `buffer.max` records, redacts sensitive fields, captures only at the framework's error-reporting hook, and **never dials out** — Waypoint pulls from it.

### Use the Probe view

1. Open the **Probe** view. Enter the endpoint **URL** (e.g. `https://your-app/_waypoint/probe`) and the **secret**.
2. Click **Pull**. You'll see the app name and environment, and a list of recent errors/logs (newest first).
3. Expand a record to see the file/line, the request input, any **breadcrumbs** (the queries and logs that led to the error), and the stack trace.
4. **Configure remotely:** tick **ring buffer** and/or list **trigger** classes — these are pushed to the probe and change what it captures next.
5. On an exception with a request, click **→ trace through backend** to re-run that request through your instrumented backend and see the captured trace.

> Waypoint reaches the probe **server-side** (no browser cross-origin issues), so it works against staging and production. The URL and secret are stored in your personal, never-committed `.waypoint/local.json`.

---

## 16. Docker mode

If your app runs in Docker, Waypoint can bring up just your **dependency services** (database, Redis, mail, search…) and point itself at them, while it drives the app process directly for instrumentation. Use this when your app/dependencies don't run natively on your machine, or when you want your real services but Waypoint-driven app code.

### Choose the compose file

In **Project settings → Docker** (shown only when compose files exist), pick the compose file, or leave it on **Auto** (which prefers standard names, then a `dev` file). Your choice is saved to the project.

Waypoint classifies each service automatically as **app** (replaced by Waypoint), **web server** (skipped), or **backing service** (brought up). It picks the first app service for tasks like route listing.

### Bring it up

The provisioning banner's **Bring up Docker** action (or Docker mode at boot) starts the backing services, reads the **actual host ports** Docker assigned, and points the app's database/cache/etc. at them. If a service publishes no host port, Waypoint warns that you'll need to join the compose network to reach it.

### Routes from the container

When your app can't boot on the host, the **Routes** and **API** views read your route list from inside the running app container automatically — no extra steps.

---

## 17. Save your work (markers & sessions)

### Markers persist automatically

Your waypoints, breakpoints, and swaps are saved to the project (`.waypoint/markers.json`) and restored when you reopen it. They're anchored to the enclosing class + method, so they **follow edits** — if a method moves, its markers move with it.

### Named sessions

A **session** is a saved snapshot of a run: its trigger (the Unit method or the HTTP request), its capture points, and the captured results. Use the **Saved sessions** panel (right rail):

- **Save** — name the current run and store it (enabled once you've run something).
- **Open** (click the name) — restore that run's Capture Log, markers, and entry.
- **Replay** (▷) — re-run the saved trigger.
- **Delete** (✕).

Sessions are saved to `.waypoint/sessions.json`.

---

## 18. Project settings

Open with the **gear** in the top bar. Settings are saved to `.waypoint/config.json` (commit this to share with your team).

- **Framework** — `Auto-detect` or a specific framework adapter.
- **Providers**
  - **ORM** — which model/database adapter the Data console uses (default: the framework's own; e.g. Eloquent for Laravel).
  - **Routes** — which adapter the Routes/API views use to list routes.
- **Docker** — which compose file Docker mode uses (Section 16).
- **Outbound mocks** — rules that fake outbound HTTP during instrumented runs. Each rule has a URL **pattern**, a **status**, and a **body**. Add with **+ Add mock**, remove with **×** (Section 9).
- **Available modules** — a read-only list of supported languages and frameworks.

Click **Save** to apply (changes take effect immediately).

---

## 19. Manage projects

- **Switch / open** projects from the top-bar project button (Section 2).
- Opened projects are remembered per machine (in `~/.waypoint/projects.json`); remove one from the list with **×** (files are untouched).
- **Provisioning** — when a project is missing setup, the banner offers explicit, one-click actions:
  - **Install dependencies** (`composer install`),
  - **Create `.env`** (copies `.env.example` and generates an app key),
  - **Run migrations**,
  - **Bring up Docker**.

  Each runs only when you click it.

---

## 20. Configuration & files reference

### Files Waypoint writes in your project (`.waypoint/`)

| File | Commit it? | Contents |
|---|---|---|
| `config.json` | **Yes** (share) | Framework, ORM/route providers, Docker compose choice, outbound HTTP mocks. |
| `local.json` | No (auto-gitignored) | Personal settings — currently the Probe URL and secret. |
| `markers.json` | Project's choice | Your waypoints, breakpoints, and swaps. |
| `sessions.json` | Project's choice | Named saved sessions. |
| `api.json` | **Yes** (share) | API console saved requests and environments. |

A per-machine list of known projects lives in `~/.waypoint/projects.json`.

### Project settings (`config.json`)

| Setting | Values | Default | Effect |
|---|---|---|---|
| Framework | a framework id, or auto | auto-detect | Which framework adapter loads. |
| ORM provider | a provider id, or default | framework default | Adapter for the Data console. |
| Route provider | a provider id, or default | framework default | Adapter for the Routes/API views. |
| Docker compose file | a filename, or auto | auto | Which compose file Docker mode uses. |
| Outbound HTTP mocks | list of `{pattern, status, body}` | none | Fake outbound HTTP on instrumented runs. |

### Environment variables (advanced)

| Variable | Default | Effect |
|---|---|---|
| `PROJECT_ROOT` | — | The project the backend serves (set by the launcher from `--project`). |
| `WP_HOST_DRIVER` | auto | Force the framework adapter (e.g. `bare` for a frameworkless project). |
| `WP_WS_PORT` | `9778` | Backend control-plane port. |
| `WAYPOINT_PTY_PORT` | `9790` | Terminal server port. |
| `NO_COLOR` | — | Disable colored launcher output. |

### Ports

| Port | Service |
|---|---|
| `5180` | Web UI |
| `9778` | Backend (control plane, WebSocket) |
| `9779` | Front-end engine (control plane), when running |
| `9777` | Backend analysis-only fallback (HTTP) |
| `9790` | Terminal server (only when started with `--terminal`) |

---

## 21. Keyboard shortcuts

| Shortcut | Where | Action |
|---|---|---|
| **Ctrl/Cmd-S** | Editor | Save the current file |
| **↑ / ↓** | Navigator | Previous / next item |
| **← / →** | Navigator | Collapse-or-parent / expand-or-open |
| **Enter / Space** | Navigator | Expand a branch or open an item |
| **type letters** | Navigator | Jump to a matching item |
| **Enter** | most input fields | Submit (send, search, run, attach, save) |
| Click the gutter | Editor | Place/remove a breakpoint or waypoint |
| Double-click a tab | Editor | Pin / unpin the tab |

---

## 22. Known limitations

- **Unit run isolation** — a class that extends a framework base (Eloquent model, framework controller) may not run in a Unit run; use a **Request run** instead.
- **Waypoint eligibility** — waypoints only attach to **public** methods (with a body).
- **Not-reproducible captures** — captures holding closures, open connections, or other non-serializable values can be inspected but not replayed.
- **Live features need a bootable app** — running, replaying, the Data console, and native route listing require the app to boot on the host (or, for routes, run in Docker). Otherwise Waypoint runs in analysis-only mode.
- **Breakpoints in a Request run** don't halt (a real request keeps going); they record where they were hit. Use **Unit → Debug** for true step/pause.
- **Front-end state capture** requires a Redux-style store on the page.
- **Replace-all writes immediately** — there's no preview; commit it deliberately (it's two-step).
