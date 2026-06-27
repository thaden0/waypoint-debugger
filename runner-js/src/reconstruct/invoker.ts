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
  preview?: unknown;
  error?: string;
  mode: string;
  committed: boolean;
  reproducible: boolean;
}

export class Invoker {
  constructor(private host: Host) {}

  /**
   * @param argOverrides authored replacements for captured args, keyed by position —
   *        the what-if dial: reconstruct the captured receiver, poke it with
   *        different inputs. Positions absent from the map keep their captured value.
   */
  async invokeSeq(
    seq: number,
    method: string,
    mode: 'peek' | 'destructive' = 'peek',
    argOverrides: Record<number, unknown> | null = null,
  ): Promise<InvokeResult> {
    const entry = recorder.entry(seq);
    if (!entry) {
      return this.fail(`no ledger entry for seq ${seq}`, mode);
    }

    let receiver: unknown;
    let args: unknown[];
    try {
      receiver = recorder.reconstruct(entry.receiver);
      args = entry.args.map((a, i) =>
        argOverrides && Object.prototype.hasOwnProperty.call(argOverrides, i)
          ? argOverrides[i]
          : recorder.reconstruct(a),
      );
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
      return { ok: true, result: summarize(result), preview: preview(result), mode, committed, reproducible: true };
    } catch (e) {
      rollback();
      return this.fail((e as Error).message, mode);
    }
  }

  private fail(error: string, mode: string): InvokeResult {
    return { ok: false, error, mode, committed: false, reproducible: true };
  }
}

/**
 * JSON-safe, depth- and size-capped rendering of an invocation result so the UI
 * can diff a what-if outcome against the baseline. Unlike summarize() (a type
 * tag), this keeps actual values, leaning on toJSON() so rich objects render as
 * data.
 */
function preview(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== 'object') {
    return typeof v === 'function' ? { __type: 'function' } : v;
  }
  if (depth >= 4) return { __truncated: Array.isArray(v) ? 'array' : 'object' };
  if (Array.isArray(v)) {
    const out = v.slice(0, 50).map((e) => preview(e, depth + 1));
    if (v.length > 50) out.push({ __more: v.length - 50 } as unknown);
    return out;
  }
  const obj = v as Record<string, unknown>;
  if (typeof obj.toJSON === 'function') {
    try {
      return { __type: obj.constructor?.name ?? 'object', value: preview((obj.toJSON as () => unknown)(), depth + 1) };
    } catch {
      // fall through
    }
  }
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [k, vv] of Object.entries(obj)) {
    if (i++ >= 50) {
      out.__more = Object.keys(obj).length - 50;
      break;
    }
    out[k] = preview(vv, depth + 1);
  }
  const name = obj.constructor?.name;
  return name && name !== 'Object' ? { __type: name, value: out } : out;
}
