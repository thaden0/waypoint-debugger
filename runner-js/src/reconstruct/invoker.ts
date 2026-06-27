import { recorder } from '../capture/recorder.js';
import type { Host } from '../host/host.js';
import { summarize } from '../run/sliceRunner.js';

// Reconstruct + invoke from a captured (or authored) ledger entry — the JS analog
// of the PHP Invoker. Rebuild receiver + args from their in-process blobs, then
// re-enter the public method directly: receiver[method](...args). Peek rolls back
// the transaction guard after landing; destructive commits.

export interface InvokeResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  mode: string;
  committed: boolean;
  reproducible: boolean;
}

export class Invoker {
  constructor(private host: Host) {}

  async invokeSeq(seq: number, method: string, mode: 'peek' | 'destructive' = 'peek'): Promise<InvokeResult> {
    const entry = recorder.entry(seq);
    if (!entry) {
      return this.fail(`no ledger entry for seq ${seq}`, mode);
    }

    let receiver: unknown;
    let args: unknown[];
    try {
      receiver = recorder.reconstruct(entry.receiver);
      args = entry.args.map((a) => recorder.reconstruct(a));
    } catch (e) {
      return { ...this.fail(`reconstruction failed: ${(e as Error).message}`, mode), reproducible: false };
    }

    if (receiver === null || typeof receiver !== 'object') {
      return this.fail('receiver did not reconstruct to an object', mode);
    }
    const fn = (receiver as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      return this.fail(`method ${method} not found on reconstructed receiver`, mode);
    }

    const [begin, commit, rollback] = this.host.transactionHooks();
    begin();
    try {
      const result = await (fn as (...a: unknown[]) => unknown).apply(receiver, args);
      let committed = false;
      if (mode === 'destructive') {
        commit();
        committed = true;
      } else {
        rollback();
      }
      return { ok: true, result: summarize(result), mode, committed, reproducible: true };
    } catch (e) {
      rollback();
      return this.fail((e as Error).message, mode);
    }
  }

  private fail(error: string, mode: string): InvokeResult {
    return { ok: false, error, mode, committed: false, reproducible: true };
  }
}
