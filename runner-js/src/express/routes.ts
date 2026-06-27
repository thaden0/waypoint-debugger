import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Express route introspection — the JS adapter's RouteProvider, proving the API
// console (and the module/adapter seam) generalizes beyond Laravel. Static, like
// nikic parsing for Laravel: we scan the source for `app.get('/x', …)` /
// `router.post('/y', …)` calls rather than booting the app. Returns the same
// route schema the PHP RouteProvider emits, so the UI is unchanged.

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor']);
const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

export interface RouteSchema {
  methods: string[];
  uri: string;
  name: string | null;
  action: string;
  middleware: string[];
  params: string[];
}

export function introspectExpressRoutes(root: string): RouteSchema[] {
  const out: RouteSchema[] = [];
  for (const file of listSources(root)) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!/\.(get|post|put|patch|delete|options|head|all)\s*\(/.test(source)) {
      continue; // cheap pre-filter
    }
    const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    let sf: ts.SourceFile;
    try {
      sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    } catch {
      continue;
    }
    const rel = path.relative(root, file);
    const visit = (node: ts.Node): void => {
      const route = matchRoute(node, sf, rel);
      if (route) out.push(route);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  // Stable order: by URI then primary method.
  out.sort((a, b) => (a.uri === b.uri ? (a.methods[0] ?? '').localeCompare(b.methods[0] ?? '') : a.uri.localeCompare(b.uri)));
  return out;
}

// Match `<obj>.METHOD('/path', …handlers)` where METHOD is an HTTP verb.
function matchRoute(node: ts.Node, sf: ts.SourceFile, file: string): RouteSchema | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return null;
  }
  const method = node.expression.name.text.toLowerCase();
  if (!HTTP_METHODS.has(method)) {
    return null;
  }
  const first = node.arguments[0];
  if (!first || !ts.isStringLiteralLike(first)) {
    return null; // path must be a string literal to introspect statically
  }
  const uri = normalize(first.text);
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  return {
    methods: method === 'all' ? ['ALL'] : [method.toUpperCase()],
    uri,
    name: null,
    action: `${file}:${line}`,
    middleware: node.arguments.length > 2 ? ['…handlers'] : [],
    params: [...uri.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
  };
}

// Normalize Express `:param` into `{param}` so the UI's existing param handling
// (shared with Laravel) works uniformly.
function normalize(uri: string): string {
  const u = '/' + uri.replace(/^\//, '');
  return u.replace(/:(\w+)/g, '{$1}');
}

function listSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (SOURCE_EXT.some((e) => name.endsWith(e)) && !name.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}
