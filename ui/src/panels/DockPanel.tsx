import { useEffect, useState } from 'react';
import { useStore, type NetworkRecord } from '../store/useStore';
import { VariablesPanel, ConsolePanel } from './RunPanels';

// The bottom dock — tabbed per concern/runner: backend Variables (the captured
// ledger) + Console, and the frontend Network panel (CDP) when a frontend runner
// is connected. This is the "tabbed per runner" surface.
type Tab = 'variables' | 'console' | 'network';

export function DockPanel() {
  const hasFrontend = useStore((s) => s.runners.some((r) => r.capabilities.includes('cdp')));
  const [tab, setTab] = useState<Tab>('variables');

  return (
    <div className="dock">
      <div className="dock__tabs">
        <button className={tab === 'variables' ? 'on' : ''} onClick={() => setTab('variables')}>
          Variables <span className="dock__badge be">BE</span>
        </button>
        <button className={tab === 'console' ? 'on' : ''} onClick={() => setTab('console')}>Console</button>
        {hasFrontend && (
          <button className={tab === 'network' ? 'on' : ''} onClick={() => setTab('network')}>
            Network <span className="dock__badge fe">FE</span>
          </button>
        )}
      </div>
      <div className="dock__body">
        {tab === 'variables' && <VariablesPanel />}
        {tab === 'console' && <ConsolePanel />}
        {tab === 'network' && <NetworkPanel />}
      </div>
    </div>
  );
}

function NetworkPanel() {
  const attached = useStore((s) => s.cdpAttached);
  const cdpUrl = useStore((s) => s.cdpUrl);
  const setCdpUrl = useStore((s) => s.setCdpUrl);
  const attach = useStore((s) => s.attachBrowser);
  const detach = useStore((s) => s.detachBrowser);
  const poll = useStore((s) => s.pollNetwork);
  const network = useStore((s) => s.network);
  const all = useStore((s) => s.networkAll);
  const setAll = useStore((s) => s.setNetworkAll);

  // Live-poll the captured network while attached.
  useEffect(() => {
    if (!attached) return;
    const t = setInterval(() => void poll(), 1500);
    return () => clearInterval(t);
  }, [attached, poll]);

  return (
    <div className="net">
      <div className="net__bar">
        {attached ? (
          <>
            <span className="net__on">● attached</span>
            <span className="muted net__url">{cdpUrl}</span>
            <label className="net__filter"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> all (incl. assets)</label>
            <button className="net__btn" onClick={() => detach()}>Detach</button>
          </>
        ) : (
          <>
            <span className="muted">Attach to your app's browser (Chrome started with <code>--remote-debugging-port</code>):</span>
            <input className="net__input" value={cdpUrl} spellCheck={false} onChange={(e) => setCdpUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && attach()} />
            <button className="net__btn primary" onClick={() => attach()}>Attach</button>
          </>
        )}
      </div>
      {attached && (
        <div className="net__table">
          {network.length === 0 ? (
            <div className="muted net__empty">No requests yet — interact with your app.</div>
          ) : (
            <table>
              <thead><tr><th>method</th><th>endpoint</th><th>type</th><th>status</th><th>time</th></tr></thead>
              <tbody>
                {network.map((r: NetworkRecord) => (
                  <tr key={r.requestId} className={r.failed ? 'failed' : ''}>
                    <td className={'net-verb v-' + r.method.toLowerCase()}>{r.method}</td>
                    <td className="net__ep" title={r.url}>{shortUrl(r.url)}</td>
                    <td className="muted">{r.type}</td>
                    <td className={'net__status s-' + Math.floor((r.status ?? 0) / 100)}>{r.failed ? '✕' : r.status ?? '…'}</td>
                    <td className="muted">{r.durationMs != null ? `${r.durationMs}ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
