import ts from 'typescript';
import type { Problem } from '../types.js';

// Flags JS/TS "problem code" — the calls that break isolation or determinism and
// are therefore the swap candidates the editor auto-highlights. Same categories
// as the PHP scanner (external.db / nondeterministic.* / io.*), tuned to the JS
// ecosystem: fetch/axios, Date.now/new Date, Math.random, crypto, storage, ORMs.

const DB_METHODS = new Set([
  'findMany', 'findUnique', 'findFirst', 'findFirstOrThrow', 'findUniqueOrThrow',
  'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
  'count', 'aggregate', 'findOne', 'find', 'save', 'insert', 'query', 'execute',
]);

const HTTP_CALLEES = new Set(['fetch']);
const HTTP_MEMBERS = new Set(['get', 'post', 'put', 'patch', 'delete', 'request']); // axios.*

export class ProblemScanner {
  scan(source: string, path = 'inline.ts'): Problem[] {
    const kind = path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
    const lines = source.split('\n');
    const hits: Problem[] = [];

    const push = (node: ts.Node, category: string, label: string) => {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const end = sf.getLineAndCharacterOfPosition(node.getEnd());
      hits.push({
        category,
        label,
        line: start.line + 1,
        endLine: end.line + 1,
        startCol: start.character,
        endCol: end.character,
        snippet: lines[start.line] ?? '',
      });
    };

    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && node.expression.getText(sf) === 'Date') {
        push(node, 'nondeterministic.time', 'new Date()');
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && HTTP_CALLEES.has(callee.text)) {
          push(node, 'io.http', `${callee.text}()`);
        } else if (ts.isPropertyAccessExpression(callee)) {
          const obj = callee.expression.getText(sf);
          const method = callee.name.text;
          const cat = categorize(obj, method);
          if (cat) push(node, cat, `${obj}.${method}()`);
        }
      } else if (ts.isPropertyAccessExpression(node)) {
        const text = node.getText(sf);
        if (text === 'process.env' || text.startsWith('process.env.')) {
          push(node, 'io.env', 'process.env');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    return hits;
  }
}

function categorize(obj: string, method: string): string | null {
  if (obj === 'Math' && method === 'random') return 'nondeterministic.random';
  if (obj === 'Date' && (method === 'now')) return 'nondeterministic.time';
  if (obj === 'performance' && method === 'now') return 'nondeterministic.time';
  if (obj === 'crypto' && (method === 'randomUUID' || method === 'getRandomValues' || method === 'randomBytes')) {
    return 'nondeterministic.random';
  }
  if ((obj === 'localStorage' || obj === 'sessionStorage') && (method === 'getItem' || method === 'setItem')) {
    return 'io.storage';
  }
  if ((obj === 'axios' || obj.endsWith('Client') || obj === 'http') && HTTP_MEMBERS.has(method)) {
    return 'io.http';
  }
  if (DB_METHODS.has(method)) return 'external.db';
  return null;
}
