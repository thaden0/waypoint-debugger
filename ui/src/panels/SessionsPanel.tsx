import { useState } from 'react';
import { useStore } from '../store/useStore';

// Save the current run (trigger + capture points + captured ledger) as a named
// session, and list saved ones to reopen (restore the ledger) or replay (re-run).
export function SessionsPanel() {
  const sessions = useStore((s) => s.sessions);
  const lastRun = useStore((s) => s.lastRun);
  const saveSession = useStore((s) => s.saveSession);
  const openSession = useStore((s) => s.openSession);
  const replaySession = useStore((s) => s.replaySession);
  const deleteSession = useStore((s) => s.deleteSession);
  const [name, setName] = useState('');

  const canSave = !!lastRun;
  const save = () => { if (canSave) { saveSession(name); setName(''); } };

  return (
    <div className="sessions">
      <div className="sessions__save">
        <input
          className="sessions__name"
          placeholder={canSave ? 'name this session…' : 'run something to save'}
          value={name}
          disabled={!canSave}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
        />
        <button className="sessions__savebtn" disabled={!canSave} onClick={save} title={canSave ? 'Save the current run' : 'Run a unit or request first'}>Save</button>
      </div>

      {sessions.length === 0 ? (
        <div className="muted sessions__empty">No saved sessions yet. Run a unit or request, then save it to replay later.</div>
      ) : (
        <div className="sessions__list">
          {sessions.map((s) => (
            <div key={s.id} className="session-row">
              <span className={'session-row__kind ' + s.runMode}>{s.runMode === 'request' ? 'REQ' : 'UNIT'}</span>
              <button className="session-row__name" onClick={() => openSession(s.id)} title="Open — restore the ledger + capture points">{s.name}</button>
              <span className="session-row__meta" title={s.runMode === 'request' ? `${s.reqMethod} ${s.reqUri}` : (s.entryMethod ?? '')}>{s.ledger.length} wp · {ago(s.createdAt)}</span>
              <button className="session-row__btn" title="Replay (re-run)" onClick={() => replaySession(s.id)}>▷</button>
              <button className="session-row__btn del" title="Delete" onClick={() => deleteSession(s.id)}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
