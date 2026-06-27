import { WebSocket } from 'ws';

// A minimal Chrome DevTools Protocol client. CDP is JSON over a WebSocket:
// commands carry an id and resolve to a matching {id, result|error}; events
// arrive without an id. This is the same request/response + push shape as our own
// control plane — so the transport that consumes it looks just like the rest of
// the tool.

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

export class CdpClient {
  private ws: WebSocket | null = null;
  private id = 0;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<(params: any) => void>>();

  connect(wsUrl: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${wsUrl}`)), timeoutMs);

      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      ws.on('message', (raw) => this.onMessage(raw.toString()));
      ws.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('CDP socket closed'));
        this.pending.clear();
      });
    });
  }

  private onMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? 'CDP error'), { data: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {});
    }
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      return Promise.reject(new Error('CDP not connected'));
    }
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: any) => void): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === this.ws?.OPEN;
  }
}
