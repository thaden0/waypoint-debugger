import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { recorder } from '../capture/recorder.js';
import type { Host } from '../host/host.js';
import { Invoker } from '../reconstruct/invoker.js';
import { SliceRunner } from '../run/sliceRunner.js';
import { StructureExtractor } from '../structure/extractor.js';
import { ProblemScanner } from '../swap/problemScanner.js';
import { Swapper } from '../swap/swapper.js';
import { WaypointInstrumenter } from '../waypoint/instrumenter.js';

// Same JSON-RPC method names as the PHP runner — this is the JS adapter's
// realization of the shared per-language contract. Point the UI at this server
// instead of the PHP host and structure/scan/swap/waypoint/run/invoke all work
// identically; only `language` differs.

type Method = (params: any) => unknown | Promise<unknown>;
const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

export function buildMethods(projectRoot: string, host: Host): Record<string, Method> {
  const structure = new StructureExtractor();
  const scanner = new ProblemScanner();
  const swapper = new Swapper();
  const waypoints = new WaypointInstrumenter();
  const root = path.resolve(projectRoot);

  const resolve = (p: string): string => {
    const full = path.isAbsolute(p) ? p : path.join(root, p);
    const rel = path.relative(root, full);
    if (rel.startsWith('..')) throw rpcError(-32002, `path escapes project root: ${p}`);
    return full;
  };
  const read = (p: string): string => {
    try {
      return readFileSync(resolve(p), 'utf8');
    } catch {
      throw rpcError(-32001, `cannot read file: ${p}`);
    }
  };

  return {
    'runner.info': () => ({
      language: 'js',
      runtime: `node ${process.version}`,
      projectRoot: root,
      capabilities: ['structure', 'scan', 'swap', 'waypoint', 'ledger', 'host', 'run', 'invoke'],
      host: host.describe(),
    }),

    'fs.read': (p: { path: string }) => ({ path: p.path, source: read(p.path) }),
    'fs.list': async () => ({ root, paths: await listSources(root) }),

    'structure.file': (p: { path: string; source?: string }) =>
      structure.extractFile(p.path, p.source ?? read(p.path)),
    'structure.tree': async (p: { root?: string }) => {
      const base = resolve(p.root ?? '.');
      const rels = await listSources(base);
      return { root: base, files: rels.map((rel) => structure.extractFile(rel, readFileSync(path.join(base, rel), 'utf8'))) };
    },

    'swap.scan': (p: { path?: string; source?: string }) => ({
      problems: scanner.scan(p.source ?? read(p.path!), p.path ?? 'inline.ts'),
    }),
    'swap.apply': (p: { path?: string; source?: string; swaps?: any[] }) =>
      swapper.apply(p.source ?? read(p.path!), p.swaps ?? [], p.path ?? 'inline.ts'),

    'waypoint.instrument': (p: { path?: string; source?: string; waypoints?: any[] }) =>
      waypoints.instrument(p.source ?? read(p.path!), p.waypoints ?? [], p.path ?? 'inline.ts'),

    'ledger.get': () => ({ entries: recorder.ledgerPublic() }),
    'ledger.reset': () => {
      recorder.reset();
      return { ok: true };
    },

    'host.describe': () => host.describe(),
    'host.boot': () => {
      host.boot();
      return host.describe();
    },
    'host.entry': (p: { method?: string; uri?: string; params?: Record<string, unknown> }) =>
      host.renderEntry(p.method ?? 'GET', p.uri ?? '/', p.params ?? {}),

    'run.slice': async (p: any) => {
      recorder.reset();
      host.boot();
      const result = await new SliceRunner(host).run({
        source: p.source ?? read(p.path),
        path: p.path,
        class: p.class,
        method: p.method,
        args: p.args ?? [],
        receiverArgs: p.receiverArgs ?? [],
        waypoints: p.waypoints ?? [],
        swaps: p.swaps ?? [],
      });
      return { ...result, ledger: recorder.ledgerPublic() };
    },

    'run.invoke': async (p: { seq: number; method: string; mode?: 'peek' | 'destructive' }) =>
      new Invoker(host).invokeSeq(p.seq, p.method, p.mode ?? 'peek'),
  };
}

async function listSources(base: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(path.join(dir, e.name));
      } else if (SOURCE_EXT.some((ext) => e.name.endsWith(ext)) && !e.name.endsWith('.d.ts')) {
        out.push(path.relative(base, path.join(dir, e.name)));
      }
    }
  }
  await walk(base);
  out.sort();
  return out;
}

export interface RpcError extends Error {
  rpcCode: number;
}
function rpcError(code: number, message: string): RpcError {
  return Object.assign(new Error(message), { rpcCode: code });
}
