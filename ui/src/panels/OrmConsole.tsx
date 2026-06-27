import { useEffect, useRef } from 'react';
import { useOrmStore, type ConsoleEntry, type Relationship } from '../store/ormStore';
import { useStore } from '../store/useStore';

// ORM data console — work with the project's data through its own Eloquent models.
// Toolbar / model list / tabbed main (Grid·Source·Relationships·Alter) / PHP query
// console along the bottom. The console evaluates real Eloquent in the booted host.
export function OrmConsole() {
  const load = useOrmStore((s) => s.load);
  const loaded = useOrmStore((s) => s.loaded);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  return (
    <div className="orm">
      <OrmToolbar />
      <div className="orm__body">
        <OrmSidebar />
        <div className="orm__right">
          <OrmMain />
          <QueryConsole />
        </div>
      </div>
    </div>
  );
}

function OrmToolbar() {
  const refresh = useOrmStore((s) => s.refresh);
  const runQuery = useOrmStore((s) => s.runQuery);
  const migrate = useOrmStore((s) => s.migrate);
  const search = useOrmStore((s) => s.search);
  const setSearch = useOrmStore((s) => s.setSearch);

  return (
    <div className="orm-bar">
      <span className="orm-bar__title">⛁ orm debug</span>
      <button className="orm-bar__action" onClick={() => refresh()}>↻ refresh</button>
      <button className="orm-bar__action" onClick={() => runQuery()}>▷ run</button>
      <button className="orm-bar__action" onClick={() => migrate(false)} title="Show migration status (click Migrate again in the console to apply)">⇪ migrate</button>
      <div className="orm-bar__spacer" />
      <input className="orm-bar__search" placeholder="search models" value={search} spellCheck={false} onChange={(e) => setSearch(e.target.value)} />
    </div>
  );
}

function OrmSidebar() {
  const models = useOrmStore((s) => s.models);
  const selected = useOrmStore((s) => s.selected);
  const select = useOrmStore((s) => s.select);
  const search = useOrmStore((s) => s.search);
  const projectRoot = useStore((s) => s.runner?.projectRoot);
  const project = projectRoot ? projectRoot.split('/').filter(Boolean).pop() : 'project';

  const shown = models.filter((m) => !search || m.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <aside className="orm-side">
      <div className="orm-side__project">
        <span className="orm-side__plabel">project</span>
        <div className="orm-side__pname">📁 {project}</div>
      </div>
      <div className="orm-side__head"><span>models</span><span className="orm-side__count">{models.length}</span></div>
      <div className="orm-side__list">
        {shown.length === 0 ? (
          <div className="muted orm-side__empty">No Eloquent models found under app/.</div>
        ) : (
          shown.map((m) => (
            <button key={m.name} className={'orm-model' + (m.name === selected ? ' on' : '')} onClick={() => select(m.name)}>
              <span className="orm-model__icon">⊞</span>
              <span className="orm-model__name">{m.name}</span>
              {m.count != null && <span className="orm-model__count">{m.count}</span>}
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

const TABS: { id: 'grid' | 'source' | 'relationships' | 'alter'; label: string }[] = [
  { id: 'grid', label: '▦ Grid' },
  { id: 'source', label: '⟨⟩ Source' },
  { id: 'relationships', label: '↬ Relationships' },
  { id: 'alter', label: '✎ Alter model' },
];

function OrmMain() {
  const tab = useOrmStore((s) => s.contentTab);
  const setTab = useOrmStore((s) => s.setContentTab);
  const selected = useOrmStore((s) => s.selected);

  if (!selected) return <div className="orm-main orm-main--empty"><span className="muted">Select a model.</span></div>;

  return (
    <div className="orm-main">
      <div className="orm-main__tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="orm-main__content">
        {tab === 'grid' && <GridView />}
        {tab === 'source' && <SourceView />}
        {tab === 'relationships' && <RelationshipsView />}
        {tab === 'alter' && <AlterView />}
      </div>
    </div>
  );
}

function cell(v: unknown) {
  if (v === null || v === undefined) return <span className="orm-null">null</span>;
  if (typeof v === 'boolean') return <span className={v ? 'orm-true' : 'orm-false'}>{String(v)}</span>;
  if (typeof v === 'object') return <span className="orm-json">{JSON.stringify(v)}</span>;
  return <span>{String(v)}</span>;
}

function GridView() {
  const table = useOrmStore((s) => s.table);
  const loadTable = useOrmStore((s) => s.loadTable);

  if (table.loading) return <div className="muted orm-pad">Loading…</div>;
  if (table.error) return <div className="orm-err orm-pad">{table.error}</div>;
  if (table.columns.length === 0) return <div className="muted orm-pad">No columns (table may not exist yet — run migrate).</div>;

  const pages = Math.max(1, Math.ceil(table.total / table.perPage));
  return (
    <div className="orm-grid">
      <div className="orm-grid__scroll">
        <table>
          <thead>
            <tr>{table.columns.map((c) => <th key={c.name} title={c.type}>{c.name}</th>)}</tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>{table.columns.map((c) => <td key={c.name}>{cell(row[c.name])}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="orm-grid__foot">
        <span className="muted">{table.total} rows</span>
        <div className="orm-grid__pager">
          <button disabled={table.page <= 1} onClick={() => loadTable(table.page - 1)}>‹</button>
          <span>{table.page} / {pages}</span>
          <button disabled={table.page >= pages} onClick={() => loadTable(table.page + 1)}>›</button>
        </div>
      </div>
    </div>
  );
}

function SourceView() {
  const source = useOrmStore((s) => s.source);
  return <pre className="orm-source">{source || <span className="muted">(no source)</span>}</pre>;
}

function RelationshipsView() {
  const relationships = useOrmStore((s) => s.relationships);
  const selected = useOrmStore((s) => s.selected);
  const select = useOrmStore((s) => s.select);
  const models = useOrmStore((s) => s.models);
  const has = (n: string | null) => !!n && models.some((m) => m.name === n);

  if (relationships.length === 0) return <div className="muted orm-pad">No relationships declared on {selected}.</div>;
  return (
    <div className="orm-rel">
      <div className="orm-rel__center">{selected}</div>
      {relationships.map((r: Relationship, i) => (
        <div className="orm-rel__row" key={i}>
          <span className="orm-rel__method">{r.method}()</span>
          <span className="orm-rel__type">{r.type}</span>
          {r.related ? (
            has(r.related) ? (
              <button className="orm-rel__target link" onClick={() => select(r.related!)}>{r.related} →</button>
            ) : (
              <span className="orm-rel__target">{r.related}</span>
            )
          ) : (
            <span className="muted">?</span>
          )}
        </div>
      ))}
    </div>
  );
}

function AlterView() {
  const alter = useOrmStore((s) => s.alter);
  const setAlter = useOrmStore((s) => s.setAlter);
  const saveAlter = useOrmStore((s) => s.saveAlter);

  return (
    <div className="orm-alter">
      <div className="orm-alter__hint">Edit model properties — saved to the model file (format-preserving).</div>
      <label className="orm-alter__field">
        <span>$table</span>
        <input value={alter.table} spellCheck={false} onChange={(e) => setAlter({ table: e.target.value })} />
      </label>
      <label className="orm-alter__field">
        <span>$fillable <em>(one per line)</em></span>
        <textarea value={alter.fillable} spellCheck={false} rows={5} onChange={(e) => setAlter({ fillable: e.target.value })} />
      </label>
      <label className="orm-alter__field">
        <span>$casts <em>(key: type)</em></span>
        <textarea value={alter.casts} spellCheck={false} rows={5} onChange={(e) => setAlter({ casts: e.target.value })} />
      </label>
      <div className="orm-alter__actions">
        <button className="orm-alter__save" disabled={alter.saving} onClick={() => saveAlter()}>{alter.saving ? 'Saving…' : 'Save model'}</button>
        {alter.saved && <span className="orm-alter__ok">✓ saved</span>}
        {alter.error && <span className="orm-err">{alter.error}</span>}
      </div>
    </div>
  );
}

function QueryConsole() {
  const log = useOrmStore((s) => s.consoleLog);
  const input = useOrmStore((s) => s.consoleInput);
  const setInput = useOrmStore((s) => s.setConsoleInput);
  const runQuery = useOrmStore((s) => s.runQuery);
  const running = useOrmStore((s) => s.running);
  const commit = useOrmStore((s) => s.commit);
  const setCommit = useOrmStore((s) => s.setCommit);
  const selected = useOrmStore((s) => s.selected);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView(); }, [log.length, running]);

  return (
    <div className="orm-console">
      <div className="orm-console__head">
        <span>⌗ PHP query console</span>
        <div className="orm-console__mode">
          <button className={commit ? '' : 'on'} onClick={() => setCommit(false)} title="Roll back writes (safe)">peek</button>
          <button className={commit ? 'on danger' : 'danger'} onClick={() => setCommit(true)} title="Commit writes to the database">commit</button>
        </div>
        <span className="orm-console__ctx">{selected ?? ''}</span>
      </div>
      <div className="orm-console__log">
        {log.length === 0 && <div className="muted">e.g. <code>{selected ? `${selected}::where('id', 1)->first()` : "User::where('active', true)->count()"}</code></div>}
        {log.map((e, i) => <ConsoleLine key={i} entry={e} />)}
        <div ref={endRef} />
      </div>
      <div className="orm-console__input">
        <span className="orm-console__prompt">{commit ? '!' : '>'}</span>
        <input
          value={input}
          spellCheck={false}
          placeholder="Eloquent / PHP expression"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void runQuery(); }}
        />
      </div>
    </div>
  );
}

function ConsoleLine({ entry }: { entry: ConsoleEntry }) {
  const capture = useOrmStore((s) => s.captureToLedger);
  const isModel = entry.ok && entry.type && !entry.type.includes('Collection') && /\\/.test(entry.type);
  return (
    <div className={'orm-line' + (entry.ok ? '' : ' err')}>
      <div className="orm-line__expr"><span className="orm-console__prompt">{entry.committed ? '!' : '>'}</span> {entry.expr}</div>
      {entry.ok ? (
        <div className="orm-line__out">
          <span className="orm-line__arrow">=&gt;</span>{' '}
          {renderResult(entry)}
          {entry.type && <span className="orm-line__type">{entry.type}</span>}
          {entry.committed && <span className="orm-line__committed">committed</span>}
          {isModel && <button className="orm-line__cap" title="Capture into the replay ledger" onClick={() => capture(entry.expr)}>→ ledger</button>}
          {(entry.sql?.length ?? 0) > 0 && <SqlPop sql={entry.sql!} />}
        </div>
      ) : (
        <div className="orm-line__err">{entry.error}</div>
      )}
    </div>
  );
}

function renderResult({ result, type }: ConsoleEntry) {
  if (result === null || result === undefined) return <code className="orm-line__val">null</code>;
  if (typeof result === 'object') {
    return <pre className="orm-line__json">{JSON.stringify(result, null, 2)}</pre>;
  }
  if (typeof result === 'boolean') return <code className="orm-line__val">{String(result)}</code>;
  return <code className="orm-line__val">{type === 'string' ? `"${result}"` : String(result)}</code>;
}

function SqlPop({ sql }: { sql: { query: string; bindings: unknown[] }[] }) {
  return (
    <details className="orm-sql">
      <summary>{sql.length} query{sql.length > 1 ? 'ies' : ''}</summary>
      {sql.map((s, i) => (
        <div className="orm-sql__line" key={i}><code>{s.query}</code>{s.bindings.length > 0 && <span className="orm-sql__bind">[{s.bindings.map((b) => JSON.stringify(b)).join(', ')}]</span>}</div>
      ))}
    </details>
  );
}
