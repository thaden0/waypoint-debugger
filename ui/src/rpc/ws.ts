// WebSocket transport to the resident host (bin/host.php). Carries request/
// response JSON-RPC AND server-pushed notifications (ledger.captured, run
// progress). When the host is up the UI prefers this wire for everything; the
// HTTP client remains the fallback for static analysis when only bin/server.php
// is running.

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

const WS_URL = `ws://${location.hostname}:9778`;

export class WsClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Set<NotificationHandler>();
  private connectedResolvers: Array<(ok: boolean) => void> = [];
  public status: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';

  connect(): Promise<boolean> {
    if (this.status === 'open') return Promise.resolve(true);
    this.status = 'connecting';
    return new Promise((resolve) => {
      this.connectedResolvers.push(resolve);
      try {
        this.ws = new WebSocket(WS_URL);
      } catch {
        this.flushConnect(false);
        return;
      }
      this.ws.addEventListener('open', () => {
        this.status = 'open';
        this.flushConnect(true);
      });
      this.ws.addEventListener('close', () => {
        this.status = 'closed';
        this.flushConnect(false);
        for (const p of this.pending.values()) p.reject(new Error('socket closed'));
        this.pending.clear();
      });
      this.ws.addEventListener('error', () => {
        if (this.status === 'connecting') this.flushConnect(false);
      });
      this.ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
    });
  }

  private flushConnect(ok: boolean) {
    this.connectedResolvers.forEach((r) => r(ok));
    this.connectedResolvers = [];
  }

  private onMessage(data: string) {
    const msg = JSON.parse(data);
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id === undefined) {
      for (const h of this.handlers) h(msg.method, msg.params ?? {});
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.status !== 'open') return Promise.reject(new Error('ws not open'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

export const wsClient = new WsClient();
