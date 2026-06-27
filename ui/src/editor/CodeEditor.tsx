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

export function CodeEditor({ placing }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const source = useStore((s) => s.source);
  const openPath = useStore((s) => s.openPath);
  const structure = useStore((s) => s.structure);
  const problems = useStore((s) => s.problems);
  const markers = useStore((s) => s.markers);
  const toggleMarker = useStore((s) => s.toggleMarker);

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

    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, decos);
  }, [markers, problems, openPath, source, structure]);

  if (!openPath) {
    return <div className="editor-empty">Open a file from the explorer or double-click a class in the canvas.</div>;
  }

  return (
    <Editor
      height="100%"
      theme="vs-dark"
      path={openPath}
      defaultLanguage="php"
      value={source}
      onMount={onMount}
      options={{
        readOnly: true,
        glyphMargin: true,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        renderLineHighlight: 'all',
      }}
    />
  );
}
