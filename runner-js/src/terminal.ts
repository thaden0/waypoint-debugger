// Standalone PTY WebSocket server — a real bash terminal for the UI's code view.
// Independent of the language runners (works for any project) so the terminal is
// always available. Protocol: client -> {t:'i',d} input | {t:'r',c,r} resize;
// server -> raw pty output as text frames.
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';

const PORT = Number(process.env.WAYPOINT_PTY_PORT ?? 9790);
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
const DEFAULT_CWD =
  process.env.PROJECT_ROOT && existsSync(process.env.PROJECT_ROOT) ? process.env.PROJECT_ROOT : process.cwd();

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
console.log(`[pty] listening on ws://127.0.0.1:${PORT} (shell=${SHELL})`);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const reqCwd = url.searchParams.get('cwd');
  const cwd = reqCwd && existsSync(reqCwd) && statSync(reqCwd).isDirectory() ? reqCwd : DEFAULT_CWD;

  const term = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  term.onData((d) => {
    try {
      ws.send(d);
    } catch {
      /* socket closing */
    }
  });
  term.onExit(() => {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  });

  ws.on('message', (raw) => {
    let msg: { t?: string; d?: string; c?: number; r?: number };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
    else if (msg.t === 'r' && msg.c && msg.r) {
      try {
        term.resize(msg.c, msg.r);
      } catch {
        /* race on teardown */
      }
    }
  });

  ws.on('close', () => term.kill());
});
