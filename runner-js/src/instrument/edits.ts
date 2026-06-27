// A position-based source edit against the ORIGINAL source. The unified pass
// collects edits from every instrumenter (all computed against the same original
// positions) and applies them once, end-to-start, so insertions never shift the
// offsets a later instrumenter relied on.

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(source: string, edits: Edit[]): string {
  // Apply from the end so earlier offsets stay valid. Ties: inserts (start===end)
  // keep a stable order; replacements don't overlap in practice.
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}
