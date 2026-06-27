import { agentInjectionSource } from './agent.js';
import { CdpClient } from './cdpClient.js';
import { FrameworkStateLedger, type StateSnapshot } from './frameworkLedger.js';

// Wires the CDP client to the framework-state ledger. attach() connects to a page
// and injects the agent; snapshot/inject read and write the framework store via
// Runtime.evaluate; pullLedger() syncs the in-page snapshot log into the node
// ledger so the UI can scrub it. readScopeAtPause() is the "free read" CDP gives
// at a Debugger.paused — VM-level inspection, complementary to the framework-state
// capture that does the heavy lifting.

export interface PausedScope {
  callFrame: string;
  scopes: Array<{ type: string; objectId?: string }>;
}

export class CdpTransport {
  readonly client = new CdpClient();
  readonly ledger = new FrameworkStateLedger();
  private lastPaused: PausedScope | null = null;

  async attach(wsUrl: string): Promise<void> {
    await this.client.connect(wsUrl);
    await this.client.send('Runtime.enable');
    await this.client.send('Debugger.enable').catch(() => {
      /* page target may not allow Debugger; framework-state capture still works */
    });

    this.client.on('Debugger.paused', (params) => {
      const top = params.callFrames?.[0];
      this.lastPaused = {
        callFrame: top ? `${top.functionName || '(anonymous)'} @ ${top.url ?? ''}:${top.location?.lineNumber ?? '?'}` : '(unknown)',
        scopes: (top?.scopeChain ?? []).map((s: any) => ({ type: s.type, objectId: s.object?.objectId })),
      };
    });

    await this.injectAgent();
  }

  /** Inject the self-contained agent into the page. */
  async injectAgent(): Promise<void> {
    await this.evaluate(agentInjectionSource(), false);
  }

  async snapshotFrameworkState(): Promise<unknown> {
    const r = await this.evaluate('globalThis.__waypoint ? globalThis.__waypoint.snapshot() : null', true);
    return r?.value ?? null;
  }

  async injectFrameworkState(state: unknown): Promise<void> {
    // State-injection: dispatch the reserved action; the wrapped reducer swaps the
    // tree and the framework re-renders. No execution replay.
    const expr = `globalThis.__waypoint && globalThis.__waypoint.inject(${JSON.stringify(state)})`;
    await this.evaluate(expr, false);
  }

  async pullLedger(): Promise<StateSnapshot[]> {
    const r = await this.evaluate('globalThis.__waypoint ? globalThis.__waypoint.getLedger() : []', true);
    const snapshots: StateSnapshot[] = Array.isArray(r?.value) ? r.value : [];
    this.ledger.sync(snapshots);
    return snapshots;
  }

  /** Time-travel to a recorded point by injecting its state. */
  async jump(seq: number): Promise<unknown> {
    const state = this.ledger.stateAt(seq);
    await this.injectFrameworkState(state);
    return state;
  }

  lastPause(): PausedScope | null {
    return this.lastPaused;
  }

  async detach(): Promise<void> {
    this.client.close();
  }

  private async evaluate(expression: string, returnByValue: boolean): Promise<any> {
    const res = await this.client.send<any>('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(`page evaluation failed: ${res.exceptionDetails.text ?? 'unknown'}`);
    }
    return res?.result;
  }
}
