import { useEffect, useState } from 'react';
import { useStore, type ProjectConfigShape } from '../store/useStore';

const STANDARD = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
// Mirror the host's auto-pick: standard name → a *dev* file → the first candidate.
function autoCompose(files: string[]): string {
  return files.find((f) => STANDARD.includes(f)) ?? files.find((f) => f.toLowerCase().includes('dev')) ?? files[0] ?? '—';
}

// Project settings — module-aware. Edit which framework module a project uses
// (or auto-detect) and override individual providers (e.g. the ORM), persisted to
// .waypoint/config.json and shared with the repo.
export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const close = useStore((s) => s.closeSettings);
  const modules = useStore((s) => s.modules);
  const config = useStore((s) => s.projectConfig);
  const save = useStore((s) => s.saveSettings);
  const saving = useStore((s) => s.savingSettings);
  const projectRoot = useStore((s) => s.runner?.projectRoot);

  const composeFiles = useStore((s) => s.composeFiles);
  const [draft, setDraft] = useState<ProjectConfigShape>({ module: null, providers: { orm: null, routes: null }, docker: { compose: null } });

  useEffect(() => {
    if (config) setDraft(config);
  }, [config]);

  if (!open) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const ormProviders = modules?.providers?.orm ?? [];
  const routeProviders = modules?.providers?.routes ?? [];
  const set = (p: Partial<ProjectConfigShape>) => setDraft({ ...draft, ...p });
  const setProvider = (k: 'orm' | 'routes', v: string | null) => setDraft({ ...draft, providers: { ...draft.providers, [k]: v } });

  return (
    <div className="settings-overlay" onClick={close}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <header className="settings__head">
          <span className="settings__title">⚙ Project settings</span>
          <button className="settings__x" onClick={close}>✕</button>
        </header>

        <div className="settings__body">
          {!modules ? (
            <div className="muted settings__loading">Loading modules…</div>
          ) : (
            <>
              <section className="settings__sec">
                <div className="settings__sec-title">Project</div>
                <div className="settings__row"><span className="settings__k">path</span><code className="settings__v">{projectRoot}</code></div>
                <div className="settings__row"><span className="settings__k">detected</span><span className="settings__v"><span className="settings__badge">{modules.detected ?? '—'}</span></span></div>
                <div className="settings__row"><span className="settings__k">active</span><span className="settings__v"><span className="settings__badge on">{modules.active ?? '—'}</span></span></div>
              </section>

              <section className="settings__sec">
                <div className="settings__sec-title">Framework module</div>
                <div className="settings__field">
                  <select value={draft.module ?? ''} onChange={(e) => set({ module: e.target.value || null })}>
                    <option value="">Auto-detect{modules.detected ? ` (${modules.detected})` : ''}</option>
                    {modules.modules.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                  </select>
                  <span className="settings__hint">Which framework adapter to use. Auto picks by project files.</span>
                </div>
              </section>

              <section className="settings__sec">
                <div className="settings__sec-title">Providers</div>
                <div className="settings__field">
                  <label className="settings__plabel">ORM</label>
                  <select value={draft.providers.orm ?? ''} onChange={(e) => setProvider('orm', e.target.value || null)}>
                    <option value="">Module default</option>
                    {ormProviders.map((p) => <option key={p.id} value={p.id}>{p.id} <span>({p.framework})</span></option>)}
                  </select>
                </div>
                <div className="settings__field">
                  <label className="settings__plabel">Routes</label>
                  <select value={draft.providers.routes ?? ''} onChange={(e) => setProvider('routes', e.target.value || null)}>
                    <option value="">Module default</option>
                    {routeProviders.map((p) => <option key={p.id} value={p.id}>{p.id} <span>({p.framework})</span></option>)}
                  </select>
                </div>
                <span className="settings__hint">Swap a single provider independent of the framework (e.g. Eloquent → Doctrine when available).</span>
              </section>

              {composeFiles.length > 0 && (
                <section className="settings__sec">
                  <div className="settings__sec-title">Docker</div>
                  <div className="settings__field">
                    <label className="settings__plabel">compose</label>
                    <select value={draft.docker.compose ?? ''} onChange={(e) => setDraft({ ...draft, docker: { compose: e.target.value || null } })}>
                      <option value="">Auto ({autoCompose(composeFiles)})</option>
                      {composeFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <span className="settings__hint">Which compose file docker mode brings up (e.g. compose.dev.yaml vs compose.prod.yaml).</span>
                </section>
              )}

              <section className="settings__sec">
                <div className="settings__sec-title">Available modules</div>
                <div className="settings__modules">
                  {modules.languages.map((l) => (
                    <div className="settings__mod" key={'lang-' + l.id}>
                      <span className="settings__mod-kind lang">language</span>
                      <span className="settings__mod-id">{l.id}</span>
                      <span className="settings__mod-role">{l.role}</span>
                      <span className="settings__mod-caps">{l.extensions.join(' ')}</span>
                    </div>
                  ))}
                  {modules.modules.map((m) => (
                    <div className="settings__mod" key={'fw-' + m.id}>
                      <span className="settings__mod-kind fw">framework</span>
                      <span className="settings__mod-id">{m.id}</span>
                      <span className="settings__mod-role">{m.role}</span>
                      <span className="settings__mod-caps">{m.capabilities.map((c) => <span key={c} className="settings__cap">{c}</span>)}</span>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>

        <footer className="settings__foot">
          {dirty && <span className="settings__dirty">unsaved changes</span>}
          <button className="settings__cancel" onClick={close}>Cancel</button>
          <button className="settings__save" disabled={!dirty || saving} onClick={() => save(draft)}>{saving ? 'Saving…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}
