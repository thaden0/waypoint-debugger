import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStore } from '../store/useStore';

const PTY_URL = `ws://${location.hostname}:9790`;

// A real bash terminal (xterm.js) wired to the standalone PTY WS server, opened
// in the project's root. Bottom dock of the code view.
export function TerminalPanel() {
  const ref = useRef<HTMLDivElement>(null);
  const projectRoot = useStore((s) => s.runner?.projectRoot ?? null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new XTerm({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      theme: { background: '#0c0c0d', foreground: '#ebebed', cursor: '#9c2a30', selectionBackground: '#3a3338' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();

    const url = PTY_URL + (projectRoot ? `?cwd=${encodeURIComponent(projectRoot)}` : '');
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
    };
    ws.onopen = () => { fit.fit(); sendResize(); };
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = () => term.write('\r\n\x1b[2m[terminal disconnected — start the PTY server]\x1b[0m\r\n');
    ws.onerror = () => term.write('\r\n\x1b[2m[no PTY server on :9790]\x1b[0m\r\n');

    const onData = term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d })); });

    const ro = new ResizeObserver(() => { try { fit.fit(); sendResize(); } catch { /* detached */ } });
    ro.observe(ref.current);

    return () => { ro.disconnect(); onData.dispose(); ws.close(); term.dispose(); };
  }, [projectRoot]);

  return <div className="terminal" ref={ref} />;
}
