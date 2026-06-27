import type { KV } from './apiStore';

// A small Postman-compatible scripting runtime: pre-request scripts and test
// scripts run against a `pm`-like API (pm.environment, pm.variables, pm.test,
// pm.expect, pm.response). It is NOT a security sandbox — scripts are the user's
// own and run in their browser, exactly like Postman. We just give them the pm
// surface and collect test results / variable mutations.

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface PreScriptResult {
  vars: KV[]; // possibly-mutated environment variables
  error?: string;
  logs: string[];
}

export interface TestScriptResult {
  tests: TestResult[];
  vars: KV[];
  error?: string;
  logs: string[];
}

export interface PmResponseInput {
  status: number;
  body: string;
  headers: Record<string, string>;
  durationMs: number;
}

// chai-lite — the subset of expect(...) assertions Postman scripts lean on.
function makeExpect() {
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  const show = (v: unknown): string => {
    try {
      return typeof v === 'string' ? `'${v}'` : JSON.stringify(v);
    } catch {
      return String(v);
    }
  };

  return function expect(actual: unknown) {
    const matchers = {
      equal: (b: unknown) => (actual === b ? undefined : fail(`expected ${show(actual)} to equal ${show(b)}`)),
      eql: (b: unknown) => (JSON.stringify(actual) === JSON.stringify(b) ? undefined : fail(`expected ${show(actual)} to deeply equal ${show(b)}`)),
      a: (t: string) => (typeof actual === t ? undefined : fail(`expected ${show(actual)} to be a ${t}`)),
      an: (t: string) => (typeof actual === t ? undefined : fail(`expected ${show(actual)} to be an ${t}`)),
      include: (b: unknown) => {
        const ok = typeof actual === 'string' ? actual.includes(String(b)) : Array.isArray(actual) ? actual.includes(b) : false;
        return ok ? undefined : fail(`expected ${show(actual)} to include ${show(b)}`);
      },
      above: (n: number) => ((actual as number) > n ? undefined : fail(`expected ${show(actual)} to be above ${n}`)),
      below: (n: number) => ((actual as number) < n ? undefined : fail(`expected ${show(actual)} to be below ${n}`)),
      property: (k: string) => (actual != null && Object.prototype.hasOwnProperty.call(actual, k) ? undefined : fail(`expected object to have property ${show(k)}`)),
      status: (n: number) => {
        const code = (actual as { code?: number; status?: number })?.code ?? (actual as { status?: number })?.status;
        return code === n ? undefined : fail(`expected status ${n} but got ${code}`);
      },
    };
    const be = {
      ...matchers,
      get ok() {
        return actual ? undefined : fail(`expected ${show(actual)} to be truthy`);
      },
      get true() {
        return actual === true ? undefined : fail(`expected ${show(actual)} to be true`);
      },
      get false() {
        return actual === false ? undefined : fail(`expected ${show(actual)} to be false`);
      },
      get null() {
        return actual === null ? undefined : fail(`expected ${show(actual)} to be null`);
      },
    };
    const have = { property: matchers.property, status: matchers.status };
    const to = { ...matchers, be, have };
    return { to, be, have, ...matchers };
  };
}

// Build the `pm` object over a mutable variable map + (optionally) a response.
function buildPm(varsMap: Map<string, string>, results: TestResult[], response?: PmResponseInput) {
  const expect = makeExpect();
  const env = {
    get: (k: string) => varsMap.get(k),
    set: (k: string, v: unknown) => varsMap.set(k, String(v)),
    unset: (k: string) => varsMap.delete(k),
    has: (k: string) => varsMap.has(k),
  };
  const pm: Record<string, unknown> = {
    environment: env,
    variables: { get: env.get, set: env.set, has: env.has },
    expect,
    test: (name: string, fn: () => void) => {
      try {
        fn();
        results.push({ name, passed: true });
      } catch (e) {
        results.push({ name, passed: false, error: (e as Error).message });
      }
    },
  };
  if (response) {
    let parsed: unknown;
    pm.response = {
      code: response.status,
      status: response.status,
      responseTime: response.durationMs,
      text: () => response.body,
      json: () => (parsed ??= JSON.parse(response.body)),
      headers: {
        get: (k: string) => response.headers[Object.keys(response.headers).find((h) => h.toLowerCase() === k.toLowerCase()) ?? k],
      },
      to: {
        have: {
          status: (n: number) => {
            if (response.status !== n) throw new Error(`expected status ${n} but got ${response.status}`);
          },
        },
        be: {
          get ok() {
            if (!(response.status >= 200 && response.status < 300)) throw new Error(`expected a 2xx status but got ${response.status}`);
            return true;
          },
        },
      },
    };
  }
  return pm;
}

function kvToMap(vars: KV[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of vars) if (v.on && v.key) m.set(v.key, v.value);
  return m;
}

// Merge mutated vars back into the KV[] shape (preserve disabled rows, append new).
function mapToKv(original: KV[], m: Map<string, string>): KV[] {
  const out = original.map((v) => (v.on && v.key && m.has(v.key) ? { ...v, value: m.get(v.key)! } : v));
  const known = new Set(original.filter((v) => v.on && v.key).map((v) => v.key));
  for (const [k, v] of m) if (!known.has(k)) out.push({ key: k, value: v, on: true });
  // Drop on-rows the script unset.
  return out.filter((v) => !v.on || !v.key || m.has(v.key) || !known.has(v.key));
}

function run(script: string, pm: Record<string, unknown>, logs: string[]): string | undefined {
  if (!script.trim()) return undefined;
  const console = { log: (...a: unknown[]) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) };
  try {
    // eslint-disable-next-line no-new-func
    new Function('pm', 'console', script)(pm, console);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

export function runPreScript(script: string, vars: KV[]): PreScriptResult {
  const map = kvToMap(vars);
  const logs: string[] = [];
  const pm = buildPm(map, []);
  const error = run(script, pm, logs);
  return { vars: mapToKv(vars, map), error, logs };
}

export function runTestScript(script: string, vars: KV[], response: PmResponseInput): TestScriptResult {
  const map = kvToMap(vars);
  const logs: string[] = [];
  const tests: TestResult[] = [];
  const pm = buildPm(map, tests, response);
  const error = run(script, pm, logs);
  return { tests, vars: mapToKv(vars, map), error, logs };
}
