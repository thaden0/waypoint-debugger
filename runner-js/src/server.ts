import { recorder } from './capture/recorder.js';
import { BareHost } from './host/host.js';
import { buildMethods } from './rpc/methods.js';
import { notifier } from './rpc/notifier.js';
import { startWsServer } from './rpc/wsServer.js';

// Resident host for the JS/TS adapter. Same role as the PHP bin/host.php: serve
// the control plane over WebSocket so the SAME UI works against either language.
//
//   PROJECT_ROOT=/path/to/app WP_WS_PORT=9778 npm run host
//
// It listens on 9778 by default — the same port the UI expects — so running this
// instead of the PHP host points the whole tool at JavaScript.

const projectRoot = process.env.PROJECT_ROOT ?? process.cwd();
const wsPort = Number(process.env.WP_WS_PORT ?? 9778);
const wsHost = process.env.WP_WS_HOST ?? '127.0.0.1';

const host = new BareHost(projectRoot);
host.boot();

// Stream captures live to connected UIs.
recorder.setNotifier((entry) => notifier.notify('ledger.captured', entry));

const methods = buildMethods(projectRoot, host);
startWsServer(methods, wsHost, wsPort);

process.stderr.write(`[js-host] driver=${host.describe().driver} root=${projectRoot}\n`);
process.stderr.write(`[js-host] listening on ws://${wsHost}:${wsPort}\n`);

process.on('SIGINT', () => {
  process.stderr.write('\n[js-host] shutting down\n');
  process.exit(0);
});
