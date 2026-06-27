// Minimal JSON-RPC 2.0 client over HTTP (proxied to the runner at /rpc in dev).
// The same method names will later be served over a WebSocket for live runs;
// this client's call() surface stays identical when that transport lands.

let nextId = 1;

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

const ENDPOINT = '/rpc';

export async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = nextId++;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) {
    throw new RpcError(res.status, `HTTP ${res.status} from runner`);
  }
  const json = await res.json();
  if (json.error) {
    throw new RpcError(json.error.code, json.error.message, json.error.data);
  }
  return json.result as T;
}

export async function ping(): Promise<{ language: string; phpVersion: string; projectRoot: string } | null> {
  try {
    const res = await fetch(ENDPOINT, { method: 'GET' });
    const json = await res.json();
    return json.result;
  } catch {
    return null;
  }
}
