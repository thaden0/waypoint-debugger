// Minimal host for the JS adapter — the analog of PHP's BareHost. It supplies
// the transaction guard hooks the Invoker/SliceRunner use (peek vs commit) and a
// synthetic entry render. A real host (Node server / framework) would render an
// actual response and wire real transaction control; the contract is identical.

export interface Host {
  describe(): { driver: string; booted: boolean; app: string; root: string };
  boot(): void;
  transactionHooks(): [begin: () => void, commit: () => void, rollback: () => void];
  renderEntry(method: string, uri: string, params?: Record<string, unknown>): { status: number; body: string; contentType: string };
}

export class BareHost implements Host {
  private booted = false;
  public txLog: string[] = [];

  constructor(private root: string) {}

  describe() {
    return { driver: 'js-bare', booted: this.booted, app: 'node', root: this.root };
  }

  boot(): void {
    this.booted = true;
  }

  transactionHooks(): [() => void, () => void, () => void] {
    return [
      () => this.txLog.push('begin'),
      () => this.txLog.push('commit'),
      () => this.txLog.push('rollback'),
    ];
  }

  renderEntry(method: string, uri: string, params: Record<string, unknown> = {}) {
    const body =
      `<!doctype html><html><body style="font-family:system-ui;padding:24px;color:#0f172a">` +
      `<h2>JS bare host</h2><p>Entry: <code>${method} ${uri}</code></p>` +
      `<pre>${JSON.stringify(params, null, 2)}</pre>` +
      `<p>Wire a Node server / framework host to render real responses here.</p></body></html>`;
    return { status: 200, body, contentType: 'text/html' };
  }
}
