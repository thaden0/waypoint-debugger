import ts from 'typescript';
import { applyEdits, type Edit } from '../instrument/edits.js';

// "Change a variable on the fly" for JS/TS. Unlike PHP (where we inject a
// reassignment before the line), JS can't reassign a `const`, so instead we
// rewrite the variable's DECLARATION initializer in the enclosing function:
//
//   const subtotal = this.subtotal(items);   ->   const subtotal = (100);
//
// The breakpoint line locates the enclosing function; we find that function's
// declaration of the named variable and replace its initializer. Works for
// const / let / var.

export interface OverrideSpec {
  line: number;
  var: string;
  expression: string;
}

export class OverrideInstrumenter {
  private editsWithMeta(source: string, overrides: OverrideSpec[], path = 'inline.ts'): { edits: Edit[]; applied: Array<{ var: string }> } {
    const kind = path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);

    const edits: Edit[] = [];
    const applied: Array<{ var: string }> = [];
    for (const o of overrides) {
      const stmt = firstStatementOnLine(sf, o.line);
      const fn = stmt ? enclosingFunction(stmt) : undefined;
      const decl = fn ? findDeclaration(fn, o.var, sf) : undefined;
      if (decl?.initializer) {
        edits.push({ start: decl.initializer.getStart(sf), end: decl.initializer.getEnd(), text: `(${o.expression})` });
        applied.push({ var: o.var });
      }
    }
    return { edits, applied };
  }

  /** Declaration-initializer rewrites as edits against the ORIGINAL source. */
  edits(source: string, overrides: OverrideSpec[], path = 'inline.ts'): Edit[] {
    return this.editsWithMeta(source, overrides, path).edits;
  }

  apply(source: string, overrides: OverrideSpec[], path = 'inline.ts'): { source: string; applied: Array<{ var: string }>; errors: string[] } {
    const { edits, applied } = this.editsWithMeta(source, overrides, path);
    return { source: applyEdits(source, edits), applied, errors: [] };
  }
}

function firstStatementOnLine(sf: ts.SourceFile, line: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 === line && isStatementish(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function findDeclaration(fn: ts.FunctionLikeDeclaration, name: string, _sf: ts.SourceFile): ts.VariableDeclaration | undefined {
  const body = (fn as ts.FunctionLikeDeclaration).body;
  if (!body) return undefined;
  let found: ts.VariableDeclaration | undefined;
  const collect = (node: ts.Node) => {
    if (node !== fn && isFunctionLike(node)) return; // don't descend nested scopes
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
    }
    ts.forEachChild(node, collect);
  };
  collect(body);
  return found;
}

function isStatementish(node: ts.Node): boolean {
  const k = node.kind;
  return (
    k === ts.SyntaxKind.ExpressionStatement || k === ts.SyntaxKind.ReturnStatement ||
    k === ts.SyntaxKind.VariableStatement || k === ts.SyntaxKind.IfStatement ||
    k === ts.SyntaxKind.ForStatement || k === ts.SyntaxKind.ForOfStatement ||
    k === ts.SyntaxKind.WhileStatement || k === ts.SyntaxKind.ThrowStatement
  );
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
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) || ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
  );
}
