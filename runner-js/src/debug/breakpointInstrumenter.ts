import ts from 'typescript';
import { applyEdits, type Edit } from '../instrument/edits.js';

// Injects a breakpoint hook before the first executable statement on each
// breakpoint line:
//
//   globalThis.__wpBreakpoint("<id>", { a, b, this: typeof this !== "undefined" ? this : undefined });
//
// JS has no get_defined_vars(), so the in-scope locals are computed STATICALLY:
// the enclosing function's parameters, hoisted `var`s, and `let`/`const`
// declared textually BEFORE the breakpoint (referencing one before its
// declaration would throw a TDZ ReferenceError, so those are excluded).

export interface BreakpointInstrumentResult {
  source: string;
  placed: Array<{ id: string; line: number; vars: string[] }>;
  skipped: Array<{ line: number; reason: string }>;
}

const STATEMENT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ExpressionStatement, ts.SyntaxKind.ReturnStatement, ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement, ts.SyntaxKind.ThrowStatement, ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.BreakStatement, ts.SyntaxKind.ContinueStatement,
]);

export class BreakpointInstrumenter {
  /** Hook inserts as position-based edits against the ORIGINAL source. */
  editsWithMeta(source: string, breakpoints: Array<{ line: number; id?: string }>, path = 'inline.ts'): {
    edits: Edit[];
    placed: BreakpointInstrumentResult['placed'];
    skipped: BreakpointInstrumentResult['skipped'];
  } {
    const kind = path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);

    const wantLines = new Map<number, { id?: string }>();
    for (const b of breakpoints) wantLines.set(b.line, b);

    const placed: BreakpointInstrumentResult['placed'] = [];
    const skipped: BreakpointInstrumentResult['skipped'] = [];
    const seen = new Set<number>();
    const edits: Edit[] = [];

    const visit = (node: ts.Node) => {
      if (STATEMENT_KINDS.has(node.kind)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const want = wantLines.get(line);
        if (want && !seen.has(line)) {
          seen.add(line);
          const id = want.id ?? `bp:${line}`;
          const vars = inScopeNames(node, sf);
          const pos = node.getStart(sf);
          edits.push({ start: pos, end: pos, text: this.hook(id, vars, indentOf(source, pos)) });
          placed.push({ id, line, vars });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const [line] of wantLines) {
      if (!seen.has(line)) skipped.push({ line, reason: 'no executable statement on this line' });
    }
    return { edits, placed, skipped };
  }

  edits(source: string, breakpoints: Array<{ line: number; id?: string }>, path = 'inline.ts'): Edit[] {
    return this.editsWithMeta(source, breakpoints, path).edits;
  }

  instrument(source: string, breakpoints: Array<{ line: number; id?: string }>, path = 'inline.ts'): BreakpointInstrumentResult {
    const { edits, placed, skipped } = this.editsWithMeta(source, breakpoints, path);
    return { source: applyEdits(source, edits), placed, skipped };
  }

  private hook(id: string, vars: string[], indent: string): string {
    const shorthand = vars.length ? vars.join(', ') + ', ' : '';
    const obj = `{ ${shorthand}this: typeof this !== "undefined" ? this : undefined }`;
    return `globalThis.__wpBreakpoint(${JSON.stringify(id)}, ${obj});\n${indent}`;
  }
}

/** Leading whitespace of the line containing `pos`. */
function indentOf(source: string, pos: number): string {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  const slice = source.slice(lineStart, pos);
  const m = slice.match(/^\s*/);
  return m ? m[0] : '';
}

/** Variables safely referenceable at the breakpoint statement. */
function inScopeNames(stmt: ts.Node, sf: ts.SourceFile): string[] {
  const fn = enclosingFunction(stmt);
  if (!fn) return [];
  const bpStart = stmt.getStart(sf);
  const names = new Set<string>();

  // Parameters are always in scope.
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) names.add(p.name.text);
  }

  // Walk the function body for variable declarations.
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (body) {
    const collect = (node: ts.Node) => {
      // Don't descend into nested functions (their scope is separate).
      if (node !== fn && isFunctionLike(node)) return;
      if (ts.isVariableDeclarationList(node)) {
        const isVar = (node.flags & ts.NodeFlags.Let) === 0 && (node.flags & ts.NodeFlags.Const) === 0;
        for (const d of node.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          // var is hoisted; let/const only if declared before the breakpoint.
          if (isVar || d.name.getEnd() <= bpStart) names.add(d.name.text);
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(body);
  }

  return [...names];
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isFunctionLike(cur)) return cur as ts.FunctionLikeDeclaration;
    cur = cur.parent;
  }
  return undefined;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}
