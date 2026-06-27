import { useEffect, useState } from 'react';
import { useStore } from './store/useStore';
import { Canvas } from './canvas/Canvas';
import { CodeEditor } from './editor/CodeEditor';
import { Explorer } from './panels/Explorer';
import { SwapPanel } from './panels/SwapPanel';
import { RunControls } from './panels/RunPanel';
import { BrowserPane, ConsolePanel, VariablesPanel } from './panels/RunPanels';
import type { MarkerKind } from './types';
import './styles.css';

export default function App() {
  const connect = useStore((s) => s.connect);
  const loadTree = useStore((s) => s.loadTree);
  const connected = useStore((s) => s.connected);
  const runner = useStore((s) => s.runner);
  const transport = useStore((s) => s.transport);
  const hasHost = useStore((s) => s.hasHost);
  const mode = useStore((s) => s.mode);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const setMode = useStore((s) => s.setMode);
  const openPath = useStore((s) => s.openPath);

  const [placing, setPlacing] = useState<MarkerKind>('breakpoint');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Retry until the runner is reachable, rather than giving up after one
      // racy attempt at mount.
      for (let i = 0; i < 40 && !cancelled; i++) {
        await connect();
        if (useStore.getState().connected) {
          await loadTree();
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connect, loadTree]);

  return (
    <div className={'app app--' + mode}>
      <header className="topbar">
        <div className="brand">
          <span className="brand__dot" /> Waypoint
        </div>

        <nav className="view-toggle">
          <button className={view === 'canvas' ? 'is-active' : ''} onClick={() => setView('canvas')}>
            Class diagram
          </button>
          <button className={view === 'code' ? 'is-active' : ''} onClick={() => setView('code')}>
            Code
          </button>
        </nav>

        {view === 'code' && openPath && (
          <div className="placing-toggle">
            placing:
            <button className={placing === 'breakpoint' ? 'is-active bp' : 'bp'} onClick={() => setPlacing('breakpoint')}>
              ● breakpoint
            </button>
            <button className={placing === 'waypoint' ? 'is-active wp' : 'wp'} onClick={() => setPlacing('waypoint')}>
              ● waypoint
            </button>
          </div>
        )}

        <div className="spacer" />

        <div className="run-controls">
          {mode === 'idle' ? (
            <button className="run-btn" onClick={() => setMode('running')} disabled={!connected}>
              ▷ Run
            </button>
          ) : (
            <button className="stop-btn" onClick={() => setMode('idle')}>
              ◻ Stop
            </button>
          )}
        </div>

        <div className={'conn ' + (connected ? 'is-up' : 'is-down')} title={`transport: ${transport}`}>
          {connected
            ? hasHost
              ? `host: ${runner?.host?.driver ?? 'php'} (${transport})`
              : `php ${runner?.phpVersion ?? ''} · static`
            : 'runner offline'}
        </div>
      </header>

      <div className="workbench">
        {/* Left rail: explorer always available. */}
        <aside className="rail">
          <div className="rail__section-title">Explorer</div>
          <Explorer />
        </aside>

        {/* Center: the navigated surface. In running mode it shares with the browser. */}
        <main className={'stage ' + (mode === 'running' ? 'stage--split' : '')}>
          <section className="stage__primary">
            <div className="stage__main">
              {view === 'canvas' ? <Canvas /> : <CodeEditor placing={placing} />}
            </div>

            {/* Bottom panels only in running mode — idle reclaims the space. */}
            {mode === 'running' && (
              <div className="stage__bottom">
                <VariablesPanel />
                <ConsolePanel />
              </div>
            )}
          </section>

          {mode === 'running' && (
            <section className="stage__browser">
              <BrowserPane />
            </section>
          )}
        </main>

        {/* Right rail: run controls + swap/waypoint workbench. */}
        <aside className="rail rail--right">
          <div className="rail__section-title">Run slice</div>
          <RunControls />
          <div className="rail__section-title">Slice &amp; swaps</div>
          <SwapPanel />
        </aside>
      </div>

      {!connected && (
        <div className="banner">
          Runner offline. Start it with:&nbsp;
          <code>PROJECT_ROOT=/path/to/laravel php -S 127.0.0.1:9777 runner/bin/server.php</code>
        </div>
      )}
    </div>
  );
}
