import { useEffect, useState } from 'react';
import { useApiStore, METHODS, type KV, type ApiRoute, type ApiRequest } from '../store/apiStore';

// Project-aware API console: a Postman-style request tab wired into the project.
// Routes are introspected from the booted host; an in-process send runs through
// the instrumented kernel (capturing into the replay ledger), an external send is
// a plain server-side call.
export function ApiConsole() {
  const load = useApiStore((s) => s.load);
  const loaded = useApiStore((s) => s.loaded);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  return (
    <div className="api">
      <CollectionSidebar />
      <div className="api__main">
        <RequestBar />
        <RequestTabs />
        <ResponseView />
      </div>
    </div>
  );
}

function CollectionSidebar() {
  const routes = useApiStore((s) => s.routes);
  const saved = useApiStore((s) => s.saved);
  const tab = useApiStore((s) => s.collectionTab);
  const setTab = useApiStore((s) => s.setCollectionTab);
  const loadRoute = useApiStore((s) => s.loadRoute);
  const loadSaved = useApiStore((s) => s.loadSaved);
  const deleteSaved = useApiStore((s) => s.deleteSaved);
  const newRequest = useApiStore((s) => s.newRequest);
  const draftId = useApiStore((s) => s.draft.id);

  return (
    <aside className="api-side">
      <EnvBar />
      <div className="api-side__tabs">
        <button className={tab === 'routes' ? 'on' : ''} onClick={() => setTab('routes')}>Routes <span className="api-side__count">{routes.length}</span></button>
        <button className={tab === 'saved' ? 'on' : ''} onClick={() => setTab('saved')}>Saved <span className="api-side__count">{saved.length}</span></button>
        <button className="api-side__new" title="New request" onClick={() => newRequest()}>+</button>
      </div>

      <div className="api-side__list">
        {tab === 'routes' ? (
          routes.length === 0 ? (
            <div className="muted api-side__empty">No routes. (The host must be a framework with a router — Laravel today.)</div>
          ) : (
            routes.map((r, i) => <RouteRow key={i} route={r} onClick={() => loadRoute(r)} />)
          )
        ) : saved.length === 0 ? (
          <div className="muted api-side__empty">No saved requests. Build one and hit Save.</div>
        ) : (
          saved.map((r) => (
            <div key={r.id} className={'api-row' + (r.id === draftId ? ' on' : '')}>
              <button className="api-row__main" onClick={() => loadSaved(r)}>
                <span className={'api-verb v-' + r.method.toLowerCase()}>{r.method}</span>
                <span className="api-row__name">{r.name}</span>
              </button>
              <button className="api-row__del" title="Delete" onClick={() => deleteSaved(r.id)}>×</button>
            </div>
          ))
        )}
      </div>

      <HistoryList />
    </aside>
  );
}

function RouteRow({ route, onClick }: { route: ApiRoute; onClick: () => void }) {
  const verb = route.methods.find((m) => m !== 'HEAD') ?? 'GET';
  return (
    <button className="api-row api-row__main" onClick={onClick} title={route.action}>
      <span className={'api-verb v-' + verb.toLowerCase()}>{verb}</span>
      <span className="api-row__uri">{route.uri}</span>
      {route.name && <span className="api-row__rname">{route.name}</span>}
    </button>
  );
}

function EnvBar() {
  const environments = useApiStore((s) => s.environments);
  const activeEnv = useApiStore((s) => s.activeEnv);
  const setActiveEnv = useApiStore((s) => s.setActiveEnv);
  const addEnv = useApiStore((s) => s.addEnv);
  const [editing, setEditing] = useState(false);

  return (
    <div className="api-env">
      <span className="api-env__label">env</span>
      <select value={activeEnv ?? ''} onChange={(e) => setActiveEnv(e.target.value || null)}>
        <option value="">(none)</option>
        {environments.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
      </select>
      <button className="api-env__edit" title="Edit variables" onClick={() => setEditing((v) => !v)}>⚙</button>
      <button className="api-env__edit" title="New environment" onClick={() => { const n = prompt('Environment name'); if (n) addEnv(n); }}>+</button>
      {editing && <EnvEditor onClose={() => setEditing(false)} />}
    </div>
  );
}

function EnvEditor({ onClose }: { onClose: () => void }) {
  const environments = useApiStore((s) => s.environments);
  const activeEnv = useApiStore((s) => s.activeEnv);
  const setEnvVars = useApiStore((s) => s.setEnvVars);
  const env = environments.find((e) => e.name === activeEnv);
  if (!env) return <div className="api-env__pop"><div className="muted">Select or create an environment.</div><button onClick={onClose}>close</button></div>;
  return (
    <div className="api-env__pop">
      <div className="api-env__pop-title">{env.name} variables · use as <code>{'{{key}}'}</code></div>
      <KVEditor rows={env.vars} onChange={(rows) => setEnvVars(env.name, rows)} keyPlaceholder="key" valuePlaceholder="value" />
      <button className="api-env__pop-close" onClick={onClose}>close</button>
    </div>
  );
}

function RequestBar() {
  const draft = useApiStore((s) => s.draft);
  const patch = useApiStore((s) => s.patchDraft);
  const send = useApiStore((s) => s.send);
  const sending = useApiStore((s) => s.sending);
  const saveDraft = useApiStore((s) => s.saveDraft);

  return (
    <div className="api-bar">
      <select className={'api-bar__method v-' + draft.method.toLowerCase()} value={draft.method} onChange={(e) => patch({ method: e.target.value })}>
        {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <input
        className="api-bar__url"
        value={draft.url}
        spellCheck={false}
        placeholder="/path or {{base}}/path"
        onChange={(e) => patch({ url: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && send()}
      />
      <div className="api-bar__target" title="In-process runs through the instrumented kernel (captures); external is a plain server-side call">
        <button className={draft.target === 'inprocess' ? 'on' : ''} onClick={() => patch({ target: 'inprocess' })}>in-process</button>
        <button className={draft.target === 'external' ? 'on' : ''} onClick={() => patch({ target: 'external' })}>external</button>
      </div>
      <button className="api-bar__send" disabled={sending} onClick={() => send()}>{sending ? '…' : 'Send'}</button>
      <button className="api-bar__save" title="Save request to .waypoint/api.json" onClick={() => saveDraft()}>Save</button>
    </div>
  );
}

const REQ_TABS = ['Params', 'Headers', 'Body', 'Auth', 'Pre-request', 'Tests'] as const;
type ReqTab = (typeof REQ_TABS)[number];

function RequestTabs() {
  const [tab, setTab] = useState<ReqTab>('Params');
  const draft = useApiStore((s) => s.draft);

  const counts: Record<ReqTab, number> = {
    Params: draft.query.filter((q) => q.on && q.key).length,
    Headers: draft.headers.filter((h) => h.on && h.key).length,
    Body: draft.bodyMode === 'none' ? 0 : 1,
    Auth: draft.auth.type === 'none' ? 0 : 1,
    'Pre-request': draft.preScript?.trim() ? 1 : 0,
    Tests: draft.testScript?.trim() ? 1 : 0,
  };

  return (
    <div className="api-req">
      <div className="api-req__tabs">
        {REQ_TABS.map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t}{counts[t] ? <span className="api-req__dot" /> : null}
          </button>
        ))}
      </div>
      <div className="api-req__body">
        {tab === 'Params' && <ParamsTab />}
        {tab === 'Headers' && <HeadersTab />}
        {tab === 'Body' && <BodyTab />}
        {tab === 'Auth' && <AuthTab />}
        {tab === 'Pre-request' && <ScriptTab field="preScript" hint="Runs before the request. e.g. pm.environment.set('ts', Date.now())" />}
        {tab === 'Tests' && <ScriptTab field="testScript" hint="Runs after the response. e.g. pm.test('ok', () => pm.response.to.have.status(200))" />}
      </div>
    </div>
  );
}

function ScriptTab({ field, hint }: { field: 'preScript' | 'testScript'; hint: string }) {
  const value = useApiStore((s) => s.draft[field] ?? '');
  const patch = useApiStore((s) => s.patchDraft);
  return (
    <div className="api-script">
      <div className="api-script__hint">{hint}</div>
      <textarea
        className="api-script__code"
        value={value}
        spellCheck={false}
        placeholder="// pm.* script"
        onChange={(e) => patch({ [field]: e.target.value })}
      />
    </div>
  );
}

function ParamsTab() {
  const query = useApiStore((s) => s.draft.query);
  const patch = useApiStore((s) => s.patchDraft);
  return <KVEditor rows={query} onChange={(rows) => patch({ query: rows })} keyPlaceholder="param" valuePlaceholder="value" />;
}

function HeadersTab() {
  const headers = useApiStore((s) => s.draft.headers);
  const patch = useApiStore((s) => s.patchDraft);
  return <KVEditor rows={headers} onChange={(rows) => patch({ headers: rows })} keyPlaceholder="header" valuePlaceholder="value" />;
}

function BodyTab() {
  const draft = useApiStore((s) => s.draft);
  const patch = useApiStore((s) => s.patchDraft);
  const modes: { id: typeof draft.bodyMode; label: string }[] = [
    { id: 'none', label: 'none' },
    { id: 'json', label: 'JSON' },
    { id: 'form', label: 'form' },
    { id: 'raw', label: 'raw' },
  ];
  return (
    <div className="api-bodytab">
      <div className="api-bodytab__modes">
        {modes.map((m) => (
          <button key={m.id} className={draft.bodyMode === m.id ? 'on' : ''} onClick={() => patch({ bodyMode: m.id })}>{m.label}</button>
        ))}
      </div>
      {draft.bodyMode === 'none' && <div className="muted api-bodytab__empty">This request has no body.</div>}
      {(draft.bodyMode === 'json' || draft.bodyMode === 'raw') && (
        <textarea
          className="api-bodytab__raw"
          value={draft.bodyRaw}
          spellCheck={false}
          placeholder={draft.bodyMode === 'json' ? '{\n  "key": "value"\n}' : 'raw body'}
          onChange={(e) => patch({ bodyRaw: e.target.value })}
        />
      )}
      {draft.bodyMode === 'form' && <KVEditor rows={draft.bodyForm} onChange={(rows) => patch({ bodyForm: rows })} keyPlaceholder="field" valuePlaceholder="value" />}
    </div>
  );
}

function AuthTab() {
  const auth = useApiStore((s) => s.draft.auth);
  const patch = useApiStore((s) => s.patchDraft);
  const set = (p: Partial<typeof auth>) => patch({ auth: { ...auth, ...p } });
  const types: { id: typeof auth.type; label: string }[] = [
    { id: 'none', label: 'None' },
    { id: 'bearer', label: 'Bearer' },
    { id: 'basic', label: 'Basic' },
    { id: 'apikey', label: 'API key' },
  ];
  return (
    <div className="api-auth">
      <div className="api-auth__types">
        {types.map((t) => <button key={t.id} className={auth.type === t.id ? 'on' : ''} onClick={() => set({ type: t.id })}>{t.label}</button>)}
      </div>
      {auth.type === 'bearer' && <input className="api-auth__in" placeholder="token (supports {{var}})" value={auth.token} spellCheck={false} onChange={(e) => set({ token: e.target.value })} />}
      {auth.type === 'basic' && (
        <div className="api-auth__row">
          <input className="api-auth__in" placeholder="username" value={auth.username} spellCheck={false} onChange={(e) => set({ username: e.target.value })} />
          <input className="api-auth__in" placeholder="password" value={auth.password} spellCheck={false} onChange={(e) => set({ password: e.target.value })} />
        </div>
      )}
      {auth.type === 'apikey' && (
        <div className="api-auth__row">
          <input className="api-auth__in" placeholder="key" value={auth.key} spellCheck={false} onChange={(e) => set({ key: e.target.value })} />
          <input className="api-auth__in" placeholder="value" value={auth.value} spellCheck={false} onChange={(e) => set({ value: e.target.value })} />
          <select value={auth.addTo} onChange={(e) => set({ addTo: e.target.value as 'header' | 'query' })}>
            <option value="header">header</option>
            <option value="query">query</option>
          </select>
        </div>
      )}
    </div>
  );
}

function KVEditor({ rows, onChange, keyPlaceholder, valuePlaceholder }: { rows: KV[]; onChange: (rows: KV[]) => void; keyPlaceholder: string; valuePlaceholder: string }) {
  // Always keep a trailing blank row to type into.
  const display = [...rows, { key: '', value: '', on: true }];
  const update = (i: number, p: Partial<KV>) => {
    const next = display.map((r, idx) => (idx === i ? { ...r, ...p } : r)).filter((r, idx) => idx < display.length - 1 || r.key || r.value);
    onChange(next);
  };
  return (
    <div className="kv">
      {display.map((r, i) => (
        <div className="kv__row" key={i}>
          <input type="checkbox" checked={r.on} onChange={(e) => update(i, { on: e.target.checked })} title="enabled" />
          <input className="kv__key" value={r.key} placeholder={keyPlaceholder} spellCheck={false} onChange={(e) => update(i, { key: e.target.value })} />
          <input className="kv__val" value={r.value} placeholder={valuePlaceholder} spellCheck={false} onChange={(e) => update(i, { value: e.target.value })} />
        </div>
      ))}
    </div>
  );
}

const RES_TABS = ['Body', 'Headers', 'Tests'] as const;
type ResTab = (typeof RES_TABS)[number];

function ResponseView() {
  const response = useApiStore((s) => s.response);
  const sending = useApiStore((s) => s.sending);
  const [tab, setTab] = useState<ResTab>('Body');
  const [pretty, setPretty] = useState(true);

  if (sending) return <div className="api-res api-res--empty"><span className="muted">Sending…</span></div>;
  if (!response) return <div className="api-res api-res--empty"><span className="muted">Send a request to see the response.</span></div>;
  if (!response.ok && response.error) return <div className="api-res api-res--empty"><span className="api-res__err">✕ {response.error}</span></div>;

  const body = response.body ?? '';
  const isJson = (response.contentType ?? '').includes('json');
  let shown = body;
  if (pretty && isJson) {
    try { shown = JSON.stringify(JSON.parse(body), null, 2); } catch { /* leave raw */ }
  }
  const tests = response.tests ?? [];
  const passed = tests.filter((t) => t.passed).length;

  return (
    <div className="api-res">
      <div className="api-res__meta">
        <span className={'api-res__status s-' + Math.floor((response.status ?? 0) / 100)}>{response.status}</span>
        <span className="muted">{response.durationMs} ms</span>
        <span className="muted">{formatSize(response.size ?? 0)}</span>
        {response.captured ? (
          <span className="api-res__cap" title="Ran through the instrumented kernel — captures are in the ledger">● captured · {response.ledgerCount} in ledger</span>
        ) : (
          <span className="api-res__cap off">external · not captured</span>
        )}
        {tests.length > 0 && (
          <span className={'api-res__tests-badge' + (passed === tests.length ? ' ok' : ' fail')}>{passed}/{tests.length} tests</span>
        )}
        <div className="api-res__tabs">
          {RES_TABS.map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}{t === 'Tests' && tests.length ? ` (${tests.length})` : ''}</button>)}
          {tab === 'Body' && isJson && <button className={'api-res__pretty' + (pretty ? ' on' : '')} onClick={() => setPretty((p) => !p)}>pretty</button>}
        </div>
      </div>
      {tab === 'Body' && <pre className="api-res__body">{shown || <span className="muted">(empty body)</span>}</pre>}
      {tab === 'Headers' && (
        <div className="api-res__headers">
          {Object.entries(response.headers ?? {}).map(([k, v]) => (
            <div className="api-res__hrow" key={k}><span className="api-res__hk">{k}</span><span className="api-res__hv">{v}</span></div>
          ))}
        </div>
      )}
      {tab === 'Tests' && (
        <div className="api-res__testlist">
          {tests.length === 0 ? (
            <div className="muted" style={{ padding: 12 }}>No tests. Add assertions in the request's Tests tab.</div>
          ) : (
            tests.map((t, i) => (
              <div className={'api-test' + (t.passed ? ' pass' : ' fail')} key={i}>
                <span className="api-test__mark">{t.passed ? '✓' : '✕'}</span>
                <span className="api-test__name">{t.name}</span>
                {!t.passed && t.error && <span className="api-test__err">{t.error}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function HistoryList() {
  const history = useApiStore((s) => s.history);
  if (history.length === 0) return null;
  return (
    <div className="api-hist">
      <div className="api-hist__title">History</div>
      {history.slice(0, 12).map((h) => (
        <div className="api-hist__row" key={h.id}>
          <span className={'api-verb v-' + h.method.toLowerCase()}>{h.method}</span>
          <span className="api-hist__url" title={h.url}>{h.url}</span>
          <span className={'api-hist__status s-' + Math.floor((h.status ?? 0) / 100)}>{h.status ?? '—'}</span>
        </div>
      ))}
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

export type { ApiRequest };
