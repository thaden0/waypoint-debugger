import vm from 'node:vm';
import ts from 'typescript';
import { recorder } from '../capture/recorder.js';
import type { Host } from '../host/host.js';
import { Swapper } from '../swap/swapper.js';
import { WaypointInstrumenter } from '../waypoint/instrumenter.js';
import type { SwapSpec, WaypointSpec } from '../types.js';

// Runs a slice: applies swaps + waypoint hooks, transpiles TS->JS, loads it in a
// fresh vm context, and drives the entry method so the hooks populate the ledger.
// The JS analog of the PHP SliceRunner. A fresh vm context per run means no class
// redeclaration clashes (the same reason PHP re-namespaces / forks a subprocess).

export interface RunRequest {
  source: string;
  path?: string;
  class: string;
  method: string;
  args?: unknown[];
  receiverArgs?: unknown[];
  waypoints?: WaypointSpec[];
  swaps?: SwapSpec[];
}

export interface RunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  ledgerCount?: number;
}

export class SliceRunner {
  constructor(private host: Host) {}

  async run(req: RunRequest): Promise<RunResult> {
    let source = req.source;
    const path = req.path ?? 'slice.ts';

    if (req.swaps?.length) source = new Swapper().apply(source, req.swaps, path).source;
    if (req.waypoints?.length) source = new WaypointInstrumenter().instrument(source, req.waypoints, path).source;

    let jsSource: string;
    try {
      jsSource = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        fileName: path,
      }).outputText;
    } catch (e) {
      return { ok: false, error: `transpile failed: ${(e as Error).message}` };
    }

    const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
    const sandbox: Record<string, unknown> = {
      module: moduleObj,
      exports: moduleObj.exports,
      require: () => ({}),
      console,
      structuredClone,
      __waypointSwaps: {},
      __wpCapture: (id: string, receiver: unknown, args: unknown[]) => recorder.capture(id, receiver, args),
    };

    try {
      vm.createContext(sandbox);
      vm.runInContext(jsSource, sandbox, { filename: path });
    } catch (e) {
      return { ok: false, error: `load failed: ${(e as Error).message}` };
    }

    const Cls = moduleObj.exports[req.class] as (new (...a: unknown[]) => Record<string, unknown>) | undefined;
    if (typeof Cls !== 'function') {
      return { ok: false, error: `class ${req.class} not exported from the slice` };
    }

    let receiver: Record<string, unknown>;
    try {
      receiver = new Cls(...(req.receiverArgs ?? []));
    } catch (e) {
      return { ok: false, error: `cannot construct receiver: ${(e as Error).message}` };
    }

    const fn = receiver[req.method];
    if (typeof fn !== 'function') {
      return { ok: false, error: `method ${req.method} not found` };
    }

    const [begin, , rollback] = this.host.transactionHooks();
    begin();
    try {
      const result = await (fn as (...a: unknown[]) => unknown).apply(receiver, req.args ?? []);
      rollback(); // a real run records but does not keep writes by default
      return { ok: true, result: summarize(result), ledgerCount: recorder.ledgerPublic().length };
    } catch (e) {
      rollback();
      return { ok: false, error: (e as Error).message };
    }
  }
}

export function summarize(result: unknown): unknown {
  if (result === null || result === undefined) return result ?? null;
  const t = typeof result;
  if (t === 'number' || t === 'string' || t === 'boolean') return result;
  // Normalize across vm realms: Array.isArray is realm-safe; plain objects are
  // detected by constructor name (their prototype is the vm realm's, not ours).
  if (Array.isArray(result) || t === 'object') {
    const proto = Object.getPrototypeOf(result);
    const ctorName = proto?.constructor?.name;
    if (Array.isArray(result) || proto === null || ctorName === 'Object') {
      try {
        return structuredClone(result);
      } catch {
        return result;
      }
    }
    return { __type: ctorName ?? 'object' };
  }
  return { __type: t };
}
