// Server->client push channel (no-id JSON-RPC notifications). The WS server
// registers a sink; capture hooks emit ledger.captured through it so the UI
// ledger fills live. Mirrors the PHP Notifier.

type Message = { jsonrpc: '2.0'; method: string; params: unknown };
type Sink = (message: Message) => void;

class Notifier {
  private sink?: Sink;

  setSink(sink: Sink | undefined): void {
    this.sink = sink;
  }

  notify(method: string, params: unknown): void {
    this.sink?.({ jsonrpc: '2.0', method, params });
  }
}

export const notifier = new Notifier();
