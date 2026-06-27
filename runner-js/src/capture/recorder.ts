import type { LedgerEntry, Snapshot } from '../types.js';

// The ledger primitive — JS analog of the PHP Recorder. Waypoint hooks call
// recorder.capture() on every method/function entry, recording { receiver, args }.
// The reproducibility gate sorts values into tiers:
//   tier 1: JSON/structured-clone-safe data (primitives, plain objects/arrays)
//   tier 2: a class instance whose own props are clone-safe (rebuilt via its proto)
//   tier 3: irreproducible (function, symbol, host object, anything not cloneable)
// Tier 3 is detected here and refused at reconstruct time rather than exploding.

interface InternalSnapshot {
  snapshot: Snapshot;
  blob: unknown; // kept in-process for reconstruction; never shipped raw
}

interface InternalEntry {
  id: string;
  seq: number;
  receiver: InternalSnapshot;
  args: InternalSnapshot[];
  reproducible: boolean;
}

export class Recorder {
  private ledger: InternalEntry[] = [];
  private seq = 0;
  private enabled = true;
  private notifier?: (entry: LedgerEntry) => void;

  setNotifier(fn: ((entry: LedgerEntry) => void) | undefined): void {
    this.notifier = fn;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  capture(id: string, receiver: unknown, args: unknown[]): void {
    if (!this.enabled) return;
    const entry: InternalEntry = {
      id,
      seq: this.seq++,
      receiver: this.snapshot(receiver),
      args: args.map((a) => this.snapshot(a)),
      reproducible: true,
    };
    const worst = Math.max(entry.receiver.snapshot.tier, ...entry.args.map((a) => a.snapshot.tier), 1);
    entry.reproducible = worst < 3;
    this.ledger.push(entry);
    this.notifier?.(this.publicEntry(entry));
  }

  snapshot(value: unknown): InternalSnapshot {
    // Tier 1 — primitives.
    if (value === null || value === undefined) {
      return { snapshot: { tier: 1, type: value === null ? 'null' : 'undefined', preview: value ?? null }, blob: value };
    }
    const t = typeof value;
    if (t === 'number' || t === 'string' || t === 'boolean' || t === 'bigint') {
      return { snapshot: { tier: 1, type: t, preview: t === 'bigint' ? String(value) : value }, blob: value };
    }
    // Tier 3 — irreproducible as data.
    if (t === 'function' || t === 'symbol') {
      return { snapshot: { tier: 3, type: t, preview: t, note: `${t} cannot be reconstructed as data` }, blob: undefined };
    }

    const proto = Object.getPrototypeOf(value);
    // Realm-safe plain check: a vm-created object's proto is the vm realm's
    // Object.prototype, not ours, so compare by constructor name as well.
    const ctorName = (proto as { constructor?: { name?: string } } | null)?.constructor?.name;
    const isPlain = Array.isArray(value) || proto === Object.prototype || proto === null || ctorName === 'Object';

    if (isPlain) {
      try {
        const blob = structuredClone(value);
        return {
          snapshot: { tier: 1, type: Array.isArray(value) ? 'array' : 'object', preview: this.preview(value) },
          blob,
        };
      } catch (e) {
        return { snapshot: { tier: 3, type: Array.isArray(value) ? 'array' : 'object', preview: '[…]', note: (e as Error).message }, blob: undefined };
      }
    }

    // Tier 2 — class instance: snapshot own enumerable props, rebuild via proto.
    const typeName = (value as object).constructor?.name ?? 'object';
    const data: Record<string, unknown> = {};
    for (const k of Object.keys(value as object)) data[k] = (value as Record<string, unknown>)[k];
    try {
      const clonedData = structuredClone(data);
      return {
        snapshot: { tier: 2, type: typeName, preview: this.preview(data) },
        blob: { proto, data: clonedData },
      };
    } catch (e) {
      return { snapshot: { tier: 3, type: typeName, preview: typeName, note: `holds non-cloneable state: ${(e as Error).message}` }, blob: undefined };
    }
  }

  /** Reconstruct a value from its in-process blob. Throws on tier 3. */
  reconstruct(internal: InternalSnapshot): unknown {
    const { snapshot, blob } = internal;
    if (snapshot.tier >= 3) {
      throw new Error(`${snapshot.type}: ${snapshot.note ?? 'not reproducible'}`);
    }
    if (snapshot.tier === 2) {
      const { proto, data } = blob as { proto: object; data: Record<string, unknown> };
      const obj = Object.create(proto);
      Object.assign(obj, structuredClone(data));
      return obj;
    }
    return structuredClone(blob);
  }

  private preview(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((v) => (this.isPrimitive(v) ? v : typeof v));
    }
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as object)) {
      if (n++ >= 20) break;
      out[k] = this.isPrimitive(v) ? v : (Array.isArray(v) ? 'array' : typeof v);
    }
    return out;
  }

  private isPrimitive(v: unknown): boolean {
    return v === null || ['number', 'string', 'boolean', 'undefined'].includes(typeof v);
  }

  ledgerPublic(): LedgerEntry[] {
    return this.ledger.map((e) => this.publicEntry(e));
  }

  entry(seq: number): InternalEntry | undefined {
    return this.ledger.find((e) => e.seq === seq);
  }

  reset(): void {
    this.ledger = [];
    this.seq = 0;
  }

  private publicEntry(e: InternalEntry): LedgerEntry {
    return {
      id: e.id,
      seq: e.seq,
      receiver: e.receiver.snapshot,
      args: e.args.map((a) => a.snapshot),
      reproducible: e.reproducible,
    };
  }
}

// Process-wide singleton (mirrors the PHP static Recorder).
export const recorder = new Recorder();
