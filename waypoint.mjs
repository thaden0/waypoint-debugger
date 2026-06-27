#!/usr/bin/env node
// Waypoint launcher — clone the repo, then `node waypoint.mjs up` to install
// everything and start the host + UI. One file, no dependencies, identical on
// Debian / Linux / macOS / Windows (no parallel shell + PowerShell scripts).
//
//   node waypoint.mjs doctor                 check prerequisites
//   node waypoint.mjs install                install runner + UI deps
//   node waypoint.mjs up [--project PATH]    install (if needed) + start everything
//   node waypoint.mjs up --build             serve a production UI build instead of dev
//
// Flags: --project <path>  --ws-port N  --http-port N  --ui-port N  --build  --no-open  --force

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const NODE_MIN = 18;
const PHP_MIN = [8, 2];

// ---- tiny ANSI helpers (respect NO_COLOR) -------------------------------------
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const bold = c(1), dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36), magenta = c(35);
const ok = (s) => console.log(`${green('✓')} ${s}`);
const warn = (s) => console.log(`${yellow('!')} ${s}`);
const err = (s) => console.error(`${red('✗')} ${s}`);
const info = (s) => console.log(`${cyan('›')} ${s}`);

// ---- arg parsing --------------------------------------------------------------
function parseArgs(argv) {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'up';
  const rest = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { cmd, flags, positional };
}

// ---- process helpers ----------------------------------------------------------
// On Windows, npm/composer are .cmd shims — shell:true lets PATH resolve them.
const SHELL = isWin;

function runSync(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: SHELL, cwd: ROOT, ...opts });
}
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: SHELL, ...opts });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}
function have(cmd, versionArg = '--version') {
  return capture(cmd, [versionArg]) !== null;
}

function phpVersion() {
  const v = capture('php', ['-r', 'echo PHP_VERSION;']);
  if (!v) return null;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? { raw: v, parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : { raw: v, parts: [0, 0, 0] };
}
const gte = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] >= b[1];

// ---- doctor -------------------------------------------------------------------
function doctor() {
  console.log(bold('\nWaypoint doctor\n'));
  let fatal = false;

  const node = Number(process.versions.node.split('.')[0]);
  if (node >= NODE_MIN) ok(`Node ${process.versions.node}`);
  else { err(`Node ${process.versions.node} — need >= ${NODE_MIN}. https://nodejs.org`); fatal = true; }

  if (have('npm')) ok(`npm ${capture('npm', ['--version'])}`);
  else { err('npm not found (ships with Node).'); fatal = true; }

  const php = phpVersion();
  if (php && gte(php.parts, PHP_MIN)) ok(`PHP ${php.raw}`);
  else if (php) { err(`PHP ${php.raw} — need >= ${PHP_MIN.join('.')}. Debian: sudo apt install php-cli`); fatal = true; }
  else { err('PHP not found. Debian: sudo apt install php-cli  ·  Windows: https://windows.php.net'); fatal = true; }

  if (have('composer')) ok(`Composer ${(capture('composer', ['--version']) || '').replace(/Composer version /, '').split(' ')[0]}`);
  else { err('Composer not found. https://getcomposer.org/download'); fatal = true; }

  // Helpful, not required.
  const exts = capture('php', ['-m']) || '';
  for (const ext of ['curl', 'mbstring', 'pdo']) {
    if (new RegExp(`^${ext}$`, 'mi').test(exts)) ok(`php-${ext}`);
    else warn(`php-${ext} missing (recommended). Debian: sudo apt install php-${ext}`);
  }

  console.log(fatal ? red('\nSome prerequisites are missing — install them and re-run.\n') : green('\nAll set.\n'));
  return !fatal;
}

// ---- install ------------------------------------------------------------------
function installStep(label, dir, marker, cmd, args) {
  const present = existsSync(path.join(ROOT, dir, marker));
  if (present && !FORCE) { ok(`${label} — already installed`); return true; }
  info(`${label} — installing…`);
  const r = runSync(cmd, args, { cwd: path.join(ROOT, dir) });
  if (r.status !== 0) { err(`${label} install failed.`); return false; }
  ok(`${label} — installed`);
  return true;
}
function install() {
  console.log(bold('\nInstalling Waypoint dependencies\n'));
  const a = installStep('PHP runner', 'runner', 'vendor', 'composer', ['install', '--no-interaction']);
  const b = installStep('JS adapter', 'runner-js', 'node_modules', 'npm', ['install']);
  const d = installStep('UI', 'ui', 'node_modules', 'npm', ['install']);
  return a && b && d;
}

// ---- up -----------------------------------------------------------------------
function waitForPort(port, host = '127.0.0.1', timeoutMs = 30000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const sock = net.connect(port, host);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); Date.now() > deadline ? resolve(false) : setTimeout(tick, 300); });
    };
    tick();
  });
}
function openBrowser(url) {
  const [cmd, args] = isWin ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, shell: SHELL }).unref(); } catch { /* ignore */ }
}

const children = [];
function spawnTagged(tag, color, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, shell: SHELL, ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = color(`[${tag}]`);
  const pipe = (stream) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) console.log(`${prefix} ${line}`);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => { if (!SHUTTING_DOWN && code) err(`[${tag}] exited with code ${code}`); });
  children.push(child);
  return child;
}

let SHUTTING_DOWN = false;
function shutdown() {
  if (SHUTTING_DOWN) return;
  SHUTTING_DOWN = true;
  console.log(dim('\nShutting down…'));
  for (const ch of children) { try { ch.kill('SIGTERM'); } catch { /* ignore */ } }
  setTimeout(() => process.exit(0), 400);
}

async function up(flags, positional) {
  const project = path.resolve(flags.project || positional[0] || path.join(ROOT, 'runner', 'tests', 'fixtures'));
  const wsPort = String(flags['ws-port'] || 9778);
  const httpPort = String(flags['http-port'] || 9777);
  const uiPort = String(flags['ui-port'] || 5180);

  if (!doctor()) return false;
  if (!install()) return false;
  if (!existsSync(project)) { err(`project path does not exist: ${project}`); return false; }

  console.log(bold('\nStarting Waypoint'));
  info(`project   ${project}`);
  info(`host      ws://127.0.0.1:${wsPort}`);
  info(`ui        http://localhost:${uiPort}\n`);

  const env = { ...process.env, PROJECT_ROOT: project, WP_WS_PORT: wsPort };

  // Resident host (boots the app once; full run + invoke over WebSocket).
  spawnTagged('host', magenta, 'php', [path.join('runner', 'bin', 'host.php')], { env });
  // HTTP fallback (static analysis when the WS host isn't up — the UI proxies /rpc here).
  spawnTagged('rpc', cyan, 'php', ['-S', `127.0.0.1:${httpPort}`, path.join('runner', 'bin', 'server.php')], { env });

  let uiUrl = `http://localhost:${uiPort}`;
  if (flags.build) {
    info('Building UI…');
    if (runSync('npm', ['run', 'build'], { cwd: path.join(ROOT, 'ui') }).status !== 0) { err('UI build failed'); return false; }
    spawnTagged('ui', green, 'npm', ['run', 'preview', '--', '--port', uiPort, '--host', '127.0.0.1'], { cwd: path.join(ROOT, 'ui') });
  } else {
    spawnTagged('ui', green, 'npm', ['run', 'dev', '--', '--port', uiPort], { cwd: path.join(ROOT, 'ui') });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const ready = await waitForPort(Number(uiPort));
  if (ready) {
    console.log(bold(green(`\n● Waypoint is up — ${uiUrl}\n`)) + dim('  Ctrl-C to stop.\n'));
    if (!flags['no-open']) openBrowser(uiUrl);
  } else {
    warn(`UI port ${uiPort} not reachable yet — it may still be starting. Open ${uiUrl} manually.`);
  }
  return true; // stay alive; children keep the event loop busy
}

// ---- help ---------------------------------------------------------------------
function help() {
  console.log(`
${bold('Waypoint')} — visual checkpoint-replay debugger

  ${cyan('node waypoint.mjs up')} ${dim('[--project PATH]')}   install (if needed) + start host + UI
  ${cyan('node waypoint.mjs doctor')}                    check prerequisites
  ${cyan('node waypoint.mjs install')}                   install runner + UI dependencies

${bold('Flags')}
  --project PATH    Laravel/PHP project to debug   ${dim('(default: bundled fixtures)')}
  --build           serve a production UI build instead of the dev server
  --no-open         don't open the browser
  --force           reinstall dependencies even if present
  --ws-port N · --http-port N · --ui-port N
`);
}

// ---- main ---------------------------------------------------------------------
const { cmd, flags, positional } = parseArgs(process.argv.slice(2));
const FORCE = !!flags.force;

(async () => {
  switch (cmd) {
    case 'doctor': process.exit(doctor() ? 0 : 1); break;
    case 'install': process.exit(install() ? 0 : 1); break;
    case 'up': { const okUp = await up(flags, positional); if (!okUp) process.exit(1); break; }
    case 'help': case '--help': case '-h': help(); break;
    default: err(`unknown command: ${cmd}`); help(); process.exit(1);
  }
})();
