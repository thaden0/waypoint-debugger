import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';
import { recorder } from '../src/capture/recorder.js';
import { BareHost } from '../src/host/host.js';
import { Invoker } from '../src/reconstruct/invoker.js';
import { handle } from '../src/rpc/wsServer.js';
import { buildMethods } from '../src/rpc/methods.js';
import { SliceRunner } from '../src/run/sliceRunner.js';
import { StructureExtractor } from '../src/structure/extractor.js';
import { ProblemScanner } from '../src/swap/problemScanner.js';
import { Swapper } from '../src/swap/swapper.js';
import { WaypointInstrumenter } from '../src/waypoint/instrumenter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSrc = readFileSync(path.join(here, '../fixtures/OrderService.ts'), 'utf8');
const lineOf = (src: string, needle: string) => src.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe('structure', () => {
  it('extracts a class with waypoint eligibility on public methods', () => {
    const s = new StructureExtractor().extractFile('OrderService.ts', fixtureSrc);
    const cls = s.nodes[0] as any;
    expect(cls.name).toBe('OrderService');
    const byName = Object.fromEntries(cls.members.map((m: any) => [m.name, m]));
    expect(byName.process.waypointEligible).toBe(true);
    expect(byName.taxRate.kind).toBe('property');
  });

  it('flags a #private method as not eligible', () => {
    const src = 'export class A { #secret() { return 1; } pub() { return 2; } }';
    const cls = new StructureExtractor().extractFile('A.ts', src).nodes[0] as any;
    const byName = Object.fromEntries(cls.members.map((m: any) => [m.name, m]));
    expect(byName['#secret'].visibility).toBe('private');
    expect(byName.pub.waypointEligible).toBe(true);
  });
});

describe('problem scanner', () => {
  it('flags fetch, Math.random, Date.now, new Date, prisma, process.env', () => {
    const src = `
      async function load() {
        const r = await fetch('/api');
        const x = Math.random();
        const t = Date.now();
        const d = new Date();
        const users = await prisma.user.findMany();
        return process.env.SECRET;
      }`;
    const cats = new ProblemScanner().scan(src).map((p) => p.category);
    expect(cats).toContain('io.http');
    expect(cats).toContain('nondeterministic.random');
    expect(cats).toContain('nondeterministic.time');
    expect(cats).toContain('external.db');
    expect(cats).toContain('io.env');
  });
});

describe('swap', () => {
  it('rewrites an initializer in indirect and replace modes', () => {
    const src = `const user = await User.findUnique({ where: { id } });\nconst other = 1;`;
    const indirect = new Swapper().apply(src, [{ line: 1, mode: 'indirect', key: 'user_1' }]);
    expect(indirect.applied).toBe(1);
    expect(indirect.source).toContain("__waypointSwaps[\"user_1\"] ??");
    expect(indirect.source).toContain('const other = 1;');

    const replace = new Swapper().apply(src, [{ line: 1, mode: 'replace', expression: 'mockUser' }]);
    expect(replace.source).toContain('const user = mockUser;');
  });
});

describe('waypoint instrument', () => {
  it('injects a capture hook at method entry', () => {
    const line = lineOf(fixtureSrc, 'process(');
    const r = new WaypointInstrumenter().instrument(fixtureSrc, [{ line, id: 'OrderService::process' }]);
    expect(r.instrumented).toHaveLength(1);
    expect(r.source).toContain('globalThis.__wpCapture("OrderService::process"');
  });
});

describe('recorder tiers', () => {
  beforeEach(() => recorder.reset());

  it('classifies primitives tier 1, class instances tier 2, functions tier 3', () => {
    expect(recorder.snapshot(42).snapshot.tier).toBe(1);
    expect(recorder.snapshot({ a: 1 }).snapshot.tier).toBe(1);
    class Foo { x = 1; }
    expect(recorder.snapshot(new Foo()).snapshot.tier).toBe(2);
    expect(recorder.snapshot(() => 1).snapshot.tier).toBe(3);
  });

  it('emits a live notification per capture', () => {
    const seen: string[] = [];
    recorder.setNotifier((e) => seen.push(e.id));
    recorder.capture('A::a', {}, [1]);
    recorder.capture('A::b', {}, [2]);
    recorder.setNotifier(undefined);
    expect(seen).toEqual(['A::a', 'A::b']);
  });
});

describe('slice run + replay', () => {
  beforeEach(() => recorder.reset());

  it('captures waypoints across nested calls and replays one', async () => {
    const host = new BareHost(here);
    // Derive waypoint lines from the structure model (how the UI does it) so we
    // anchor on method *declarations*, not call sites.
    const cls = new StructureExtractor().extractFile('OrderService.ts', fixtureSrc).nodes[0] as any;
    const methodLine = (name: string) => cls.members.find((m: any) => m.name === name).line.start;
    const waypoints = ['process', 'subtotal', 'tax'].map((n) => ({ line: methodLine(n) }));

    const result = await new SliceRunner(host).run({
      source: fixtureSrc,
      path: 'OrderService.ts',
      class: 'OrderService',
      method: 'process',
      args: [[{ price: 10 }, { price: 5.5 }]],
      waypoints,
    });

    expect(result.ok).toBe(true);
    expect((result.result as any).subtotal).toBe(15.5);
    expect((result.result as any).tax).toBe(1.55);

    const ids = recorder.ledgerPublic().map((e) => e.id);
    expect(ids).toContain('OrderService::process');
    expect(ids).toContain('OrderService::subtotal');
    expect(ids).toContain('OrderService::tax');

    // Replay the captured tax() call from its waypoint.
    const taxSeq = recorder.ledgerPublic().find((e) => e.id === 'OrderService::tax')!.seq;
    const replay = await new Invoker(host).invokeSeq(taxSeq, 'tax', 'peek');
    expect(replay.ok).toBe(true);
    expect(replay.result).toBe(1.55);
    expect(replay.preview).toBe(1.55);
    expect(replay.committed).toBe(false);
    expect(host.txLog.at(-1)).toBe('rollback');

    // What-if: re-invoke the same checkpoint with a different subtotal arg.
    const whatIf = await new Invoker(host).invokeSeq(taxSeq, 'tax', 'peek', { 0: 100 });
    expect(whatIf.ok).toBe(true);
    expect(whatIf.result).toBe(10);
    expect(whatIf.preview).toBe(10);
  });
});

describe('rpc contract parity', () => {
  it('runner.info reports js with the same capability names', async () => {
    const methods = buildMethods(here, new BareHost(here));
    const res = await handle(methods, { jsonrpc: '2.0', id: 1, method: 'runner.info' });
    expect(res.result.language).toBe('js');
    expect(res.result.capabilities).toEqual(
      expect.arrayContaining(['structure', 'scan', 'swap', 'waypoint', 'ledger', 'run', 'invoke']),
    );
  });

  it('returns -32601 for an unknown method', async () => {
    const methods = buildMethods(here, new BareHost(here));
    const res = await handle(methods, { jsonrpc: '2.0', id: 2, method: 'nope.nope' });
    expect(res.error.code).toBe(-32601);
  });
});
