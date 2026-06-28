import { useEffect, useRef } from 'react';
import Editor, { type Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useStore } from '../store/useStore';
import type { MarkerKind } from '../types';

// VS Code-style gutter: red tick = breakpoint, blue tick = waypoint. Waypoints
// are only accepted on waypoint-eligible lines (public method declarations) — the
// re-entry points the reconstruct+invoke primitive uses. Problem code (DB /
// non-deterministic / I/O) is decorated inline as the swap-candidate set.

interface Props {
  placing: MarkerKind;
}

// The UI is language-neutral; the editor just picks highlighting by extension so
// it renders whichever adapter (PHP or JS/TS) the host serves.
const EXT_LANG: Record<string, string> = {
  php: 'php', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', lock: 'json', md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', xml: 'xml', svg: 'xml', vue: 'html',
  sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql', env: 'ini', ini: 'ini', toml: 'ini', conf: 'ini', txt: 'plaintext',
};
function languageFor(path: string): string {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name.startsWith('.env')) return 'ini';
  if (name.endsWith('.blade.php')) return 'html';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return EXT_LANG[ext] ?? 'plaintext';
}

// Editor tabs. The unlocked tab is a single italic "preview" slot, reused when
// you open another file. A filled oxblood dot = locked (pinned): it survives
// opening other files and switching to the Class diagram. Click a tab to focus
// it; click the dot or double-click the tab to lock/unlock.
function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const openPath = useStore((s) => s.openPath);
  const openFile = useStore((s) => s.openFile);
  const toggleTabLock = useStore((s) => s.toggleTabLock);
  const closeTab = useStore((s) => s.closeTab);
  if (tabs.length === 0) return null;

  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <div
          key={t.path}
          role="tab"
          aria-selected={t.path === openPath}
          className={'tab' + (t.path === openPath ? ' is-active' : '') + (t.locked ? ' is-locked' : '')}
          title={t.path + (t.locked ? ' · locked' : ' · preview (double-click to lock)')}
          onClick={() => openFile(t.path)}
          onDoubleClick={() => toggleTabLock(t.path)}
        >
          <button
            className="tab__lock"
            title={t.locked ? 'Locked — click to unlock' : 'Preview — click to lock open'}
            onClick={(e) => { e.stopPropagation(); toggleTabLock(t.path); }}
          >
            {t.locked ? '●' : '○'}
          </button>
          <span className="tab__name">{t.path.split('/').pop()}</span>
          <button className="tab__close" title="Close" onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}>×</button>
        </div>
      ))}
    </div>
  );
}

export function CodeEditor({ placing }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const source = useStore((s) => s.source);
  const savedSource = useStore((s) => s.savedSource);
  const imageView = useStore((s) => s.imageView);
  const setEditedSource = useStore((s) => s.setEditedSource);
  const saveFile = useStore((s) => s.saveFile);
  const openPath = useStore((s) => s.openPath);
  const structure = useStore((s) => s.structure);
  const problems = useStore((s) => s.problems);
  const markers = useStore((s) => s.markers);
  const toggleMarker = useStore((s) => s.toggleMarker);
  const revealLine = useStore((s) => s.revealLine);
  const clearReveal = useStore((s) => s.clearReveal);
  const currentLine = useStore((s) => s.currentLine);

  // Eligible waypoint lines = public method declaration lines.
  const eligibleLines = new Set<number>();
  for (const node of structure?.nodes ?? []) {
    if (node.kind === 'function') continue;
    for (const m of node.members) {
      if (m.kind === 'method' && m.waypointEligible) eligibleLines.add(m.line.start);
    }
  }

  function onMount(ed: editor.IStandaloneCodeEditor, monaco: Monaco) {
    editorRef.current = ed;
    monacoRef.current = monaco;

    ed.onMouseDown((e: editor.IEditorMouseEvent) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      if (!line) return;
      if (placing === 'waypoint' && !eligibleLines.has(line)) {
        // Invalid waypoint site: blue ticks only land on public-method lines.
        return;
      }
      toggleMarker(line, placing);
    });

    // Ctrl/Cmd+S saves the edited source to disk.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void useStore.getState().saveFile();
    });
  }

  // Redraw all decorations whenever the artifacts change.
  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;

    const decos: editor.IModelDeltaDecoration[] = [];

    for (const m of markers.filter((mk) => mk.path === openPath)) {
      decos.push({
        range: new monaco.Range(m.line, 1, m.line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: m.kind === 'breakpoint' ? 'wp-glyph-breakpoint' : 'wp-glyph-waypoint',
          glyphMarginHoverMessage: { value: m.kind === 'breakpoint' ? 'Breakpoint' : 'Waypoint — captures receiver + args on entry' },
        },
      });
    }

    for (const line of eligibleLines) {
      decos.push({
        range: new monaco.Range(line, 1, line, 1),
        options: { linesDecorationsClassName: 'wp-eligible-line' },
      });
    }

    for (const p of problems) {
      decos.push({
        range: new monaco.Range(p.line, (p.startCol ?? 0) + 1, p.endLine, (p.endCol ?? 0) + 1),
        options: {
          inlineClassName: 'wp-problem',
          hoverMessage: { value: `**${p.category}** — \`${p.label}\` · swap candidate` },
        },
      });
    }

    // Current execution line while paused in an interactive debug session.
    if (currentLine) {
      decos.push({
        range: new monaco.Range(currentLine, 1, currentLine, 1),
        options: { isWholeLine: true, className: 'wp-current-line', glyphMarginClassName: 'wp-current-glyph' },
      });
    }

    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, decos);
  }, [markers, problems, openPath, source, structure, currentLine]);

  // Reveal + flash a line when a canvas member is clicked (zoom-to-method).
  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco || !revealLine) return;
    ed.revealLineInCenter(revealLine);
    ed.setPosition({ lineNumber: revealLine, column: 1 });
    const ids = ed.deltaDecorations([], [
      { range: new monaco.Range(revealLine, 1, revealLine, 1), options: { isWholeLine: true, className: 'wp-reveal-flash' } },
    ]);
    const t = setTimeout(() => {
      ed.deltaDecorations(ids, []);
      clearReveal();
    }, 1400);
    return () => clearTimeout(t);
  }, [revealLine, source, clearReveal]);

  if (!openPath) {
    return <div className="editor-empty">Open a file from the explorer or double-click a class in the canvas.</div>;
  }

  // Image files render in an <img> rather than the code editor.
  if (imageView) {
    return (
      <div className="code-pane">
        <TabStrip />
        <div className="code-pane__bar">
          <span className="code-pane__path">{openPath}</span>
          <span className="code-pane__imeta">{imageView.mime}</span>
        </div>
        <div className="code-pane__image"><img src={imageView.url} alt={openPath} /></div>
      </div>
    );
  }

  const dirty = source !== savedSource;

  return (
    <div className="code-pane">
      <TabStrip />
      <div className="code-pane__bar">
        <span className="code-pane__path">{openPath}{dirty && <span className="code-pane__dirty" title="unsaved changes"> ●</span>}</span>
        <button className="code-pane__save" disabled={!dirty} onClick={() => saveFile()} title="Save (⌘/Ctrl+S)">
          {dirty ? 'Save' : 'Saved'}
        </button>
      </div>
      <div className="code-pane__editor">
        <Editor
          height="100%"
          theme="vs-dark"
          path={openPath}
          language={languageFor(openPath)}
          value={source}
          onMount={onMount}
          onChange={(value) => setEditedSource(value ?? '')}
          options={{
            readOnly: false,
            glyphMargin: true,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            renderLineHighlight: 'all',
          }}
        />
      </div>
    </div>
  );
}
