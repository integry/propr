import { canonicalFleetJson, type FleetResetBinding } from '@propr/shared';
import { ResetGenerationFence, resetUnavailable, type ResetIdentity } from './resetFence.js';

export type ResetBoundary = 'queue' | 'sessions' | 'tunnel_bootstrap';
export interface ResetObservation {
  binding: FleetResetBinding;
  /** Monotonic external revision, not a timestamp or cached local acknowledgement. */
  revision: string;
  refused: true;
  remaining: 0;
  connections: 0;
}
/** The external service must fence by this exact binding and expose a durable,
 * monotonic read. A timeout is uncertain: reconciliation reads, never retries. */
export interface ResetExternalBoundary {
  revoke(binding: FleetResetBinding): Promise<void>;
  observe(binding: FleetResetBinding): Promise<ResetObservation | undefined>;
}
export interface ResetAdapter {
  readonly name: ResetBoundary;
  stop(binding: FleetResetBinding): Promise<void>;
  observe(binding: FleetResetBinding): Promise<ResetObservation | undefined>;
}
export function checkedObservation(value: ResetObservation | undefined, binding: FleetResetBinding): ResetObservation {
  if (!value || canonicalFleetJson(value.binding) !== canonicalFleetJson(binding) ||
    !/^[A-Za-z0-9:_-]{1,160}$/.test(value.revision) || value.refused !== true || value.remaining !== 0 || value.connections !== 0) resetUnavailable();
  return value!;
}

/** Actual BullMQ worker/queue and Redis connection methods. Injection is at the
 * transport boundary; pause/drain/close sequencing lives here in production. */
export class ResetQueueAdapter implements ResetAdapter {
  readonly name = 'queue' as const;
  private closed = false;
  constructor(private readonly fence: ResetGenerationFence,
    private readonly workers: readonly { pause(doNotWaitActive?: boolean): Promise<void>; close(): Promise<void> }[],
    private readonly queues: readonly { pause(): Promise<void>; drain(delayed?: boolean): Promise<void>; close(): Promise<void> }[],
    private readonly connections: readonly { quit(): Promise<unknown> }[],
    private readonly external: ResetExternalBoundary, private readonly quiescenceTimeoutMs = 30_000) {}
  async stop(binding: FleetResetBinding) {
    if (!this.fence.sealed(binding)) resetUnavailable();
    // Fence first, then wait for running jobs. Delayed/repeat/future jobs are
    // invalidated by the external generation fence as well as local draining.
    for (const queue of this.queues) await queue.pause();
    for (const worker of this.workers) await worker.pause(false);
    for (const worker of this.workers) await worker.close();
    for (const queue of this.queues) { await queue.drain(true); await queue.close(); }
    for (const connection of this.connections) await connection.quit();
    await this.external.revoke(binding);
    // External revocation can finish before other Core processes finish their
    // asynchronous shutdown. Wait for their durable leases before recording proof.
    await this.fence.waitForIdle(binding, this.quiescenceTimeoutMs);
    this.closed = true;
  }
  async observe(binding: FleetResetBinding) {
    // On restart, external proof must include closure of all predecessor owners.
    if (!this.fence.sealed(binding) || !this.fence.idle()) return;
    const observation = await this.external.observe(binding);
    if (!this.fence.sealed(binding) || !this.fence.idle()) return;
    return observation;
  }
  get locallyClosed() { return this.closed; }
}

/** Provider credentials, managed app sessions and local bootstrap/tunnel grants
 * share a durable generation-aware authority store. Remote revocation is still
 * mandatory; deleting local credentials alone is never terminal proof. */
export class ResetAuthorityAdapter implements ResetAdapter {
  constructor(readonly name: 'sessions' | 'tunnel_bootstrap', private readonly fence: ResetGenerationFence,
    private readonly handles: readonly { close(): Promise<unknown> }[], private readonly external: ResetExternalBoundary) {}
  issue(identity: ResetIdentity, kind: 'provider' | 'app' | 'tunnel' | 'bootstrap') { return this.fence.issue(identity, `${this.name}:${kind}`); }
  accepts(identity: ResetIdentity, kind: 'provider' | 'app' | 'tunnel' | 'bootstrap', credential: string) {
    return this.fence.accepts(identity, `${this.name}:${kind}`, credential);
  }
  async stop(binding: FleetResetBinding) {
    if (!this.fence.sealed(binding)) resetUnavailable();
    for (const handle of this.handles) await handle.close();
    this.fence.revoke(binding);
    await this.external.revoke(binding);
  }
  async observe(binding: FleetResetBinding) {
    if (!this.fence.revoked(binding)) return;
    return this.external.observe(binding);
  }
}

/** Fixed-action service boundary. Provisioned by Fleet, never by reset callers.
 * The service owns its monotonic revision and must include every predecessor
 * connection/credential/job, including delayed and future-on-boot work. */
export class HttpResetBoundary implements ResetExternalBoundary {
  constructor(private readonly origin: string, private readonly secret: () => string,
    private readonly service: ResetBoundary, private readonly transport: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') resetUnavailable();
  }
  private async call(action: 'revoke' | 'observe', binding: FleetResetBinding) {
    const response = await this.transport(new URL(`/internal/core-reset/${this.service}/${action}`, this.origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret()}` },
      body: canonicalFleetJson({ binding }),
    });
    if (!response.ok) { await response.body?.cancel(); resetUnavailable(); }
    if (!response.body) resetUnavailable();
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = []; let size = 0; let ended = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { ended = true; break; }
        size += value.byteLength;
        if (size > 16384) resetUnavailable();
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } finally {
      try { if (!ended) await reader.cancel(); } finally { reader.releaseLock(); }
    }
  }
  async revoke(binding: FleetResetBinding) { await this.call('revoke', binding); }
  async observe(binding: FleetResetBinding) { return checkedObservation(await this.call('observe', binding), binding); }
}
