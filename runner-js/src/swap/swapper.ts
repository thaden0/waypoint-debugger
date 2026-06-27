import ts from 'typescript';
import type { SwapSpec } from '../types.js';

export const SWAP_MAP_VAR = '__waypointSwaps';

// Rewrites swap sites via the AST (positions), then splices the source — the JS
// analog of the PHP Swapper. A swap site is an expression hole: the replacement
// is arbitrary code. Two modes:
//   replace:  const u = User.findUnique(...)  ->  const u = <expression>
//   indirect: const u = User.findUnique(...)  ->  const u = __waypointSwaps['key'] ?? (User.findUnique(...))

export class Swapper {
  apply(source: string, swaps: SwapSpec[], path = 'inline.ts'): { source: string; applied: number; errors: string[] } {
    const kind = path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
    const byLine = new Map<number, SwapSpec>();
    for (const s of swaps) byLine.set(s.line, s);

    const edits: Array<{ start: number; end: number; text: string }> = [];
    const errors: string[] = [];

    const initializerFor = (node: ts.Node): ts.Expression | undefined => {
      if (ts.isVariableStatement(node)) {
        const decl = node.declarationList.declarations[0];
        return decl?.initializer;
      }
      if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) &&
          node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return node.expression.right;
      }
      return undefined;
    };

    const visit = (node: ts.Node) => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const swap = byLine.get(line);
      if (swap) {
        const init = initializerFor(node);
        if (init) {
          try {
            edits.push({ start: init.getStart(sf), end: init.getEnd(), text: this.replacement(swap, init.getText(sf)) });
            byLine.delete(line); // one swap per line
          } catch (e) {
            errors.push(`line ${line}: ${(e as Error).message}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    // Apply edits from the end so earlier offsets stay valid.
    edits.sort((a, b) => b.start - a.start);
    let out = source;
    for (const e of edits) {
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }

    return { source: out, applied: edits.length, errors };
  }

  private replacement(swap: SwapSpec, original: string): string {
    if ((swap.mode ?? 'indirect') === 'replace') {
      return swap.expression ?? 'undefined';
    }
    const key = swap.key ?? `swap_${swap.line}`;
    return `${SWAP_MAP_VAR}[${JSON.stringify(key)}] ?? (${original})`;
  }
}
