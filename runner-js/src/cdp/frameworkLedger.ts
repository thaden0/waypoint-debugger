// Node-side mirror of the in-page framework ledger. The agent records state
// snapshots in the browser; the transport pulls them here so the UI can scrub the
// timeline and pick a snapshot to inject. Snapshots are plain serializable state
// trees — the FE ledger is the *easy* slot (the framework already keeps this data
// serializable for SSR/HMR), unlike PHP where state lives in live objects.

export interface StateSnapshot {
  seq: number;
  action: string;
  state: unknown;
}

export class FrameworkStateLedger {
  private snapshots: StateSnapshot[] = [];

  /** Replace the ledger with what was pulled from the page. */
  sync(snapshots: StateSnapshot[]): void {
    this.snapshots = snapshots.slice();
  }

  append(snapshot: StateSnapshot): void {
    this.snapshots.push(snapshot);
  }

  list(): StateSnapshot[] {
    return this.snapshots.slice();
  }

  /** The state to inject to time-travel to a given point. */
  stateAt(seq: number): unknown {
    return this.snapshots.find((s) => s.seq === seq)?.state ?? null;
  }

  reset(): void {
    this.snapshots = [];
  }

  get size(): number {
    return this.snapshots.length;
  }
}
