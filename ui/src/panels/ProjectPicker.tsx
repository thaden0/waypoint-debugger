import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';

// Header project picker — the UI over ~/.waypoint/projects.json. Switch between
// known projects or open a new folder (which registers it). Replaces the bare
// path input.
export function ProjectPicker() {
  const projects = useStore((s) => s.projects);
  const openProject = useStore((s) => s.openProject);
  const addProject = useStore((s) => s.addProject);
  const removeProject = useStore((s) => s.removeProject);
  const loadProjects = useStore((s) => s.loadProjects);
  const connected = useStore((s) => s.connected);
  const projectRoot = useStore((s) => s.runner?.projectRoot);

  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const activeName = projectRoot ? projectRoot.split('/').filter(Boolean).pop() : 'no project';
  const activePath = projectRoot ? projectRoot.replace(/\/+$/, '') : '';

  useEffect(() => { if (connected) void loadProjects(); }, [connected, loadProjects]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setAdding(false); } };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const pick = async (p: string) => {
    if (p === activePath) { setOpen(false); return; }
    setBusy(true);
    try { await openProject(p); } finally { setBusy(false); setOpen(false); }
  };
  const addNew = async () => {
    if (!path.trim()) return;
    setBusy(true);
    try { await addProject(path.trim()); setPath(''); setAdding(false); setOpen(false); }
    finally { setBusy(false); }
  };

  return (
    <div className="picker" ref={ref}>
      <button className="picker__btn" disabled={!connected} onClick={() => setOpen((v) => !v)} title={projectRoot ?? ''}>
        <span className="picker__icon">📁</span>
        <span className="picker__name">{busy ? '…' : activeName}</span>
        <span className="picker__caret">▾</span>
      </button>
      {open && (
        <div className="picker__menu">
          {projects.length === 0 && <div className="picker__empty muted">No known projects yet.</div>}
          {projects.map((p) => (
            <div key={p.path} className={'picker__row' + (p.path === activePath ? ' on' : '')}>
              <button className="picker__row-main" onClick={() => pick(p.path)} title={p.path}>
                {p.path === activePath && <span className="picker__dot" />}
                <span className="picker__row-name">{p.name}</span>
                {p.module && <span className="picker__mod">{p.module}</span>}
              </button>
              <button className="picker__remove" title="Remove from list" onClick={() => removeProject(p.path)}>×</button>
            </div>
          ))}
          <div className="picker__sep" />
          {adding ? (
            <div className="picker__add">
              <input
                autoFocus
                value={path}
                placeholder="/absolute/path/to/project"
                spellCheck={false}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void addNew(); if (e.key === 'Escape') setAdding(false); }}
              />
              <button className="picker__add-go" disabled={busy} onClick={() => addNew()}>Open</button>
            </div>
          ) : (
            <button className="picker__open" onClick={() => setAdding(true)}>+ Open folder…</button>
          )}
        </div>
      )}
    </div>
  );
}

// Non-blocking provisioning card — surfaced when an opened project looks
// unprovisioned. Each action is explicit (composer install / .env / migrate /
// docker up); nothing runs until clicked.
export function ProvisioningCard() {
  const status = useStore((s) => s.projectStatus);
  const dismissed = useStore((s) => s.statusDismissed);
  const provision = useStore((s) => s.provision);
  const provisioning = useStore((s) => s.provisioning);
  const dismiss = useStore((s) => s.dismissStatus);

  if (!status || dismissed || status.issues.length === 0) return null;

  return (
    <div className="provision">
      <span className="provision__warn">⚠</span>
      <span className="provision__msg">
        This project looks unprovisioned — {status.issues.map((i) => i.label).join(' · ')}
      </span>
      <div className="provision__actions">
        {status.issues.map((i) => (
          <button key={i.action} className="provision__btn" disabled={!!provisioning} onClick={() => provision(i.action)}>
            {provisioning === i.action ? '…' : labelFor(i.action)}
          </button>
        ))}
        {status.actions.map((a) => (
          <button key={a.id} className="provision__btn ghost" disabled={!!provisioning} onClick={() => provision(a.id)}>
            {provisioning === a.id ? '…' : a.label}
          </button>
        ))}
      </div>
      <button className="provision__x" title="Dismiss" onClick={dismiss}>✕</button>
    </div>
  );
}

function labelFor(action: string): string {
  switch (action) {
    case 'composer-install': return 'Install deps';
    case 'env-setup': return 'Create .env';
    case 'migrate': return 'Run migrations';
    case 'docker-up': return 'Bring up Docker';
    default: return action;
  }
}
