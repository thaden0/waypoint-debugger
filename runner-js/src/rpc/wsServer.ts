import { WebSocketServer, type WebSocket } from 'ws';
import { notifier } from './notifier.js';

// WebSocket JSON-RPC server for the JS adapter. Uses the `ws` package (Node makes
// raw WS framing painful, and unlike the PHP side we have a mature library here),
// but speaks the exact same protocol as the PHP host: request/response by id plus
// server-pushed notifications (ledger.captured) over one wire.

type Method = (params: any) => unknown | Promise<unknown>;

export function startWsServer(methods: Record<string, Method>, host: string, port: number): WebSocketServer {
  const wss = new WebSocketServer({ host, port });
  const clients = new Set<WebSocket>();

  notifier.setSink((message) => {
    const data = JSON.stringify(message);
    for (const c of clients) {
      if (c.readyState === c.OPEN) c.send(data);
    }
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', async (raw) => {
      let req: any;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const response = await handle(methods, req);
      if (response !== null) ws.send(JSON.stringify(response));
    });
  });

  return wss;
}

export async function handle(methods: Record<string, Method>, req: any): Promise<any | null> {
  const id = req?.id ?? null;
  const method = req?.method;
  if (typeof method !== 'string' || !(method in methods)) {
    return error(id, -32601, `method not found: ${method ?? '(none)'}`);
  }
  try {
    const result = await methods[method](req.params ?? {});
    if (id === null || id === undefined) return null; // notification
    return { jsonrpc: '2.0', id, result };
  } catch (e: any) {
    const code = typeof e?.rpcCode === 'number' ? e.rpcCode : -32603;
    return error(id, code, e?.message ?? 'internal error');
  }
}

function error(id: any, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
