import { useState } from 'react';
import { call } from '../rpc/client';
import { wsClient } from '../rpc/ws';
import { useStore } from '../store/useStore';

// Prefer the live WS transport (where run/search RPCs are served) and fall back
// to HTTP, matching the other stores.
async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (wsClient.status === 'open') return wsClient.call<T>(method, params);
  return call<T>(method, params);
}

interface Match { line: number; col: number; text: string; }
interface FileResult { path: string; matches: Match[]; }

// Project-wide search and replace. Search returns matches grouped by file; each
// match jumps to that line in the editor. Replace-all rewrites files in place
// (two-step confirm, since it's destructive).
export function SearchPanel() {
  const revealMember = useStore((s) => s.revealMember);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<FileResult[]>([]);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState(false); // replace-all confirm step

  const run = async () => {
    setPending(false);
    if (!query.trim()) { setResults([]); setTotal(0); setInfo(null); return; }
    setBusy(true); setError(null); setInfo(null);
    try {
      const res = await rpc<{ results: FileResult[]; total: number; capped: boolean }>('fs.search', { query, regex, caseSensitive });
      setResults(res.results); setTotal(res.total); setCapped(res.capped);
    } catch (e) { setError((e as Error).message); setResults([]); setTotal(0); }
    finally { setBusy(false); }
  };

  const doReplace = async () => {
    setPending(false); setBusy(true); setError(null);
    try {
      const res = await rpc<{ files: number; count: number }>('fs.replaceAll', { query, replacement, regex, caseSensitive });
      setInfo(`Replaced ${res.count} occurrence(s) in ${res.files} file(s).`);
      const open = useStore.getState().openPath;
      if (open) await useStore.getState().openFile(open); // refresh editor if the open file changed
      await run();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="search">
      <div className="search__inputs">
        <div className="search__row">
          <input className="search__field" placeholder="Search project…" value={query} spellCheck={false} autoFocus
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run(); }} />
          <button className={'search__opt' + (caseSensitive ? ' is-on' : '')} title="Match case" onClick={() => setCaseSensitive((v) => !v)}>Aa</button>
          <button className={'search__opt' + (regex ? ' is-on' : '')} title="Regular expression" onClick={() => setRegex((v) => !v)}>.*</button>
          <button className="search__go" disabled={busy} onClick={run}>{busy ? '…' : 'Search'}</button>
        </div>
        <div className="search__row">
          <input className="search__field" placeholder="Replace…" value={replacement} spellCheck={false} onChange={(e) => setReplacement(e.target.value)} />
          {pending ? (
            <>
              <button className="search__replace is-confirm" disabled={busy} onClick={doReplace}>Confirm: replace {total}</button>
              <button className="search__cancel" onClick={() => setPending(false)}>cancel</button>
            </>
          ) : (
            <button className="search__replace" disabled={busy || total === 0} onClick={() => setPending(true)}>Replace all</button>
          )}
        </div>
        <div className="search__status">
          {error && <span className="search__err">✕ {error}</span>}
          {info && <span className="search__info">{info}</span>}
          {!error && !info && total > 0 && <span className="muted">{total} match{total !== 1 ? 'es' : ''} in {results.length} file{results.length !== 1 ? 's' : ''}{capped ? ' · capped at 2000' : ''}</span>}
          {!error && !info && total === 0 && query && !busy && <span className="muted">No matches</span>}
        </div>
      </div>

      <div className="search__results">
        {results.map((f) => (
          <div key={f.path} className="search-file">
            <div className="search-file__head">{f.path} <span className="muted">{f.matches.length}</span></div>
            {f.matches.map((m, i) => (
              <div key={i} className="search-match" onClick={() => revealMember(f.path, m.line)} title={`${f.path}:${m.line}`}>
                <span className="search-match__ln">{m.line}</span>
                <span className="search-match__text">{m.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
