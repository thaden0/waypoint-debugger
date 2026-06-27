import { BreakpointInstrumenter } from '../debug/breakpointInstrumenter.js';
import { OverrideInstrumenter, type OverrideSpec } from '../debug/overrideInstrumenter.js';
import { Swapper } from '../swap/swapper.js';
import type { SwapSpec, WaypointSpec } from '../types.js';
import { WaypointInstrumenter } from '../waypoint/instrumenter.js';
import { applyEdits, type Edit } from './edits.js';

// Single-pass instrumentation (JS analog of the PHP Instrumenter). Every
// instrumenter computes its edits against the SAME original source positions;
// we merge and apply them once, so insertions never shift the offsets a later
// instrumenter relied on (the bug when these ran as sequential re-parsing passes
// — e.g. a waypoint hook at method entry pushing a breakpoint a line off).

export interface InstrumentOps {
  swaps?: SwapSpec[];
  overrides?: OverrideSpec[];
  waypoints?: WaypointSpec[];
  breakpoints?: Array<{ line: number; id?: string }>;
}

export class Instrumenter {
  apply(source: string, ops: InstrumentOps, path = 'inline.ts'): string {
    const edits: Edit[] = [
      ...(ops.swaps?.length ? new Swapper().edits(source, ops.swaps, path) : []),
      ...(ops.overrides?.length ? new OverrideInstrumenter().edits(source, ops.overrides, path) : []),
      ...(ops.waypoints?.length ? new WaypointInstrumenter().edits(source, ops.waypoints, path) : []),
      ...(ops.breakpoints?.length ? new BreakpointInstrumenter().edits(source, ops.breakpoints, path) : []),
    ];
    return applyEdits(source, edits);
  }
}
