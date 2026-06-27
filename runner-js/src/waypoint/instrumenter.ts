import ts from 'typescript';
import type { WaypointSpec } from '../types.js';

// Injects capture hooks at the entry of selected methods/functions — the JS
// analog of the PHP WaypointInstrumenter. On every entry it records
// { receiver, args }, the reconstruct+invoke unit. The hook calls a global the
// SliceRunner installs:
//   globalThis.__wpCapture('<id>', this, Array.from(arguments));
//
// Only MethodDeclaration / FunctionDeclaration are instrumented (they have an
// `arguments` object); arrow-property methods are skipped, mirroring PHP only
// instrumenting real methods.

export interface InstrumentResult {
  source: string;
  instrumented: Array<{ id: string; line: number; method: string }>;
  skipped: Array<{ line: number; reason: string }>;
}

export class WaypointInstrumenter {
  instrument(source: string, waypoints: WaypointSpec[], path = 'inline.ts'): InstrumentResult {
    const kind = path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
    const byLine = new Map<number, WaypointSpec>();
    for (const w of waypoints) byLine.set(w.line, w);

    const instrumented: InstrumentResult['instrumented'] = [];
    const skipped: InstrumentResult['skipped'] = [];
    const inserts: Array<{ pos: number; text: string }> = [];

    const visit = (node: ts.Node, className: string | null) => {
      let nextClass = className;
      if (ts.isClassDeclaration(node) && node.name) nextClass = node.name.text;

      if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const wp = byLine.get(line);
        if (wp) {
          const name = node.name ? node.name.getText(sf) : '(anonymous)';
          const owner = ts.isMethodDeclaration(node) ? (className ?? '(global)') : '(global)';
          const id = wp.id ?? `${owner}::${name}`;
          if (node.body && ts.isBlock(node.body)) {
            const pos = node.body.getStart(sf) + 1; // just after '{'
            inserts.push({
              pos,
              text: ` globalThis.__wpCapture(${JSON.stringify(id)}, typeof this === 'undefined' ? null : this, Array.from(arguments));`,
            });
            instrumented.push({ id, line, method: `${owner}::${name}` });
          } else {
            skipped.push({ line, reason: 'no block body (arrow/abstract)' });
          }
        }
      }
      ts.forEachChild(node, (c) => visit(c, nextClass));
    };
    visit(sf, null);

    inserts.sort((a, b) => b.pos - a.pos);
    let out = source;
    for (const ins of inserts) out = out.slice(0, ins.pos) + ins.text + out.slice(ins.pos);

    return { source: out, instrumented, skipped };
  }
}
