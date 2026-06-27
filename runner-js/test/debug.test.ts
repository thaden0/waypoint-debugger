import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { recorder } from '../src/capture/recorder.js';
import { breakpoint } from '../src/debug/breakpoint.js';
import { BreakpointInstrumenter } from '../src/debug/breakpointInstrumenter.js';
import { OverrideInstrumenter } from '../src/debug/overrideInstrumenter.js';
import { BareHost } from '../src/host/host.js';
import { SliceRunner } from '../src/run/sliceRunner.js';
import { StructureExtractor } from '../src/structure/extractor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(path.join(here, '../fixtures/OrderService.ts'), 'utf8');
const lineOf = (needle: string) => fixture.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe('breakpoint instrumenter (static scope)', () => {
  it('captures params + let/const declared BEFORE the line, not the TDZ ones', () => {
    const line = lineOf('const tax = this.tax(subtotal)');
    const r = new BreakpointInstrumenter().instrument(fixture, [{ line, id: 'bp:tax' }]);
    expect(r.placed).toHaveLength(1);
    expect(r.source).toContain('globalThis.__wpBreakpoint("bp:tax"');
    const vars = r.placed[0].vars;
    expect(vars).toContain('items'); // parameter
    expect(vars).toContain('subtotal'); // declared on the previous line
    expect(vars).not.toContain('tax'); // declared ON this line -> TDZ, excluded
  });
});

describe('breakpoint run', () => {
  beforeEach(() => breakpoint.reset());

  it('halt mode pauses at the line with the captured scope', async () => {
    const line = lineOf('const tax = this.tax(subtotal)');
    const result = await new SliceRunner(new BareHost(here)).run({
      source: fixture,
      path: 'OrderService.ts',
      class: 'OrderService',
      method: 'process',
      args: [[{ price: 10 }, { price: 5.5 }]],
      breakpoints: [{ line, id: 'bp:tax' }],
      breakpointMode: 'halt',
    });

    expect(result.ok).toBe(true);
    expect(result.paused).toBe(true);
    expect(result.breakpoint!.id).toBe('bp:tax');
    const scope = result.breakpoint!.scope as Record<string, { preview: unknown }>;
    expect(Object.keys(scope).sort()).toEqual(['items', 'subtotal', 'this']);
    expect(scope.subtotal.preview).toBe(15.5);
  });

  it('trace mode records hits and keeps running', async () => {
    const line = lineOf('const tax = this.tax(subtotal)');
    const result = await new SliceRunner(new BareHost(here)).run({
      source: fixture,
      path: 'OrderService.ts',
      class: 'OrderService',
      method: 'process',
      args: [[{ price: 10 }, { price: 5.5 }]],
      breakpoints: [{ line, id: 'bp:tax' }],
      breakpointMode: 'trace',
    });

    expect(result.ok).toBe(true);
    expect(result.paused).toBeFalsy();
    expect((result.result as { tax: number }).tax).toBe(1.55);
    expect(breakpoint.hits()).toHaveLength(1);
  });
});

describe('single-pass instrumentation (combined ops)', () => {
  beforeEach(() => breakpoint.reset());

  it('a waypoint at method entry + a breakpoint inside land on the right lines', async () => {
    const cls = new StructureExtractor().extractFile('OrderService.ts', fixture).nodes[0] as any;
    const wpLine = cls.members.find((m: any) => m.name === 'process').line.start;
    const bpLine = lineOf('const tax = this.tax(subtotal)');

    const result = await new SliceRunner(new BareHost(here)).run({
      source: fixture,
      path: 'OrderService.ts',
      class: 'OrderService',
      method: 'process',
      args: [[{ price: 10 }, { price: 5.5 }]],
      waypoints: [{ line: wpLine }],
      breakpoints: [{ line: bpLine, id: 'bp:tax' }],
      breakpointMode: 'halt',
    });

    expect(result.ok).toBe(true);
    expect(result.paused).toBe(true);
    // halted on the tax line (subtotal in scope) — not pushed up by the waypoint hook
    const scope = result.breakpoint!.scope as Record<string, { preview: unknown }>;
    expect(Object.keys(scope).sort()).toEqual(['items', 'subtotal', 'this']);
    // and the waypoint fired before the halt
    expect(recorder.ledgerPublic().map((e) => e.id)).toContain('OrderService::process');
  });
});

describe('variable override (change a const on the fly)', () => {
  it('rewrites the declaration initializer and re-runs', () => {
    const bpLine = lineOf('const tax = this.tax(subtotal)');
    const r = new OverrideInstrumenter().apply(fixture, [{ line: bpLine, var: 'subtotal', expression: '100' }]);
    expect(r.applied).toEqual([{ var: 'subtotal' }]);
    expect(r.source).toContain('const subtotal = (100);');
  });

  it('changes the result through a re-run', async () => {
    const bpLine = lineOf('const tax = this.tax(subtotal)');
    const result = await new SliceRunner(new BareHost(here)).run({
      source: fixture,
      path: 'OrderService.ts',
      class: 'OrderService',
      method: 'process',
      args: [[{ price: 10 }, { price: 5.5 }]],
      overrides: [{ line: bpLine, var: 'subtotal', expression: '100' }],
    });
    expect(result.ok).toBe(true);
    const out = result.result as { subtotal: number; tax: number; total: number };
    expect(out.subtotal).toBe(100); // const subtotal rewritten to 100
    expect(out.tax).toBe(10); // tax(100) = 100 * 0.1
    expect(out.total).toBe(110);
  });
});
