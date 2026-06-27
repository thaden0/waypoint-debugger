import { recorder } from '../capture/recorder.js';
import type { Snapshot } from '../types.js';

// Runtime side of a JS breakpoint — analog of the PHP Breakpoint. An injected
// hook calls hit() with an object of the in-scope locals (JS has no
// get_defined_vars(), so the instrumenter computes the names statically and the
// hook captures them by name).
//
//  - "halt"  : capture scope, stream the hit, then throw BreakpointHalt to stop
//              the run at that line (run-to-breakpoint).
//  - "trace" : capture + stream every hit, keep running (logpoint-style).

export class BreakpointHalt extends Error {
  constructor(public bpId: string, public scope: Record<string, Snapshot>) {
    super(`breakpoint halt: ${bpId}`);
    this.name = 'BreakpointHalt';
  }
}

export interface BreakpointHit {
  id: string;
  scope: Record<string, Snapshot>;
}

class Breakpoint {
  private mode: 'halt' | 'trace' = 'halt';
  private collected: BreakpointHit[] = [];
  private notifier?: (hit: BreakpointHit) => void;

  setMode(mode: 'halt' | 'trace'): void {
    this.mode = mode;
  }

  setNotifier(fn: ((hit: BreakpointHit) => void) | undefined): void {
    this.notifier = fn;
  }

  reset(): void {
    this.collected = [];
  }

  hits(): BreakpointHit[] {
    return this.collected;
  }

  hit(id: string, vars: Record<string, unknown>): void {
    const scope: Record<string, Snapshot> = {};
    for (const [name, value] of Object.entries(vars)) {
      scope[name] = recorder.snapshot(value).snapshot; // display-only view
    }
    const hit: BreakpointHit = { id, scope };
    this.collected.push(hit);
    this.notifier?.(hit);
    if (this.mode === 'halt') {
      throw new BreakpointHalt(id, scope);
    }
  }
}

export const breakpoint = new Breakpoint();
