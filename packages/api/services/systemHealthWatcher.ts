import { activityFromHealthChange } from './activityEvents.js';
import { getSocketService } from './socketService.js';

/**
 * Watches instance health so the surfaces that show it do not have to poll.
 *
 * A daemon, a worker, Redis or a coding agent can stop without anything in a
 * run's lifecycle saying so - the API socket stays up, no task transitions, no
 * indexing activity - so there is no event to derive a health change from. This
 * instance therefore looks at the status snapshot itself and tells its clients
 * when what they are showing actually changed. Like `usage:update`, the event is
 * a bare trigger: each client re-reads `/api/status`, which keeps owning the
 * projection and its permission check.
 */

const DEFAULT_PROBE_INTERVAL_MS = 30_000;

/**
 * The snapshot fields that are health.
 *
 * An allowlist rather than the whole response: the snapshot also carries a
 * timestamp and routing diagnostics that move on their own, and publishing for
 * those would ask every client to re-read for something it does not show.
 */
const HEALTH_FIELDS = [
  'api',
  'redis',
  'daemon',
  'worker',
  'workerCount',
  'githubAuth',
  'githubAuthMode',
  'githubEventIntake',
  'githubEventIntakeStatus',
  'claudeAuth',
  'indexing',
] as const;

type StatusSnapshot = Record<string, unknown>;

export interface SystemHealthWatcherOptions {
  intervalMs?: number;
  /** The same snapshot `/api/status` answers with; production passes the route's builder. */
  readSnapshot: () => Promise<StatusSnapshot>;
  /** Test seam; production broadcasts to this instance's operational clients. */
  publish?: () => void;
  /** Whether anyone is connected to be told. */
  hasListeners?: () => boolean;
}

function publishHealthChanged(): void {
  getSocketService()?.broadcastPushEvent(activityFromHealthChange(new Date().toISOString()));
}

function agentFingerprint(agents: unknown): unknown {
  if (!Array.isArray(agents)) return agents ?? null;
  return agents
    .map(agent => {
      const record = (agent ?? {}) as Record<string, unknown>;
      return [record.id ?? '', record.type ?? '', record.alias ?? '', record.status ?? ''];
    })
    // Registry order is not part of health; a reordered list is not a change.
    .sort((left, right) => String(left).localeCompare(String(right)));
}

function warningFingerprint(warnings: unknown): unknown {
  if (!Array.isArray(warnings)) return warnings ?? null;
  return warnings
    .map(warning => {
      const record = (warning ?? {}) as Record<string, unknown>;
      return [record.type ?? '', record.message ?? ''];
    })
    .sort((left, right) => String(left).localeCompare(String(right)));
}

/** What the health surfaces show, reduced to something comparable. */
export function healthFingerprint(snapshot: StatusSnapshot): string {
  return JSON.stringify({
    fields: HEALTH_FIELDS.map(field => snapshot[field] ?? null),
    agents: agentFingerprint(snapshot.agents),
    warnings: warningFingerprint(snapshot.warnings),
  });
}

export class SystemHealthWatcher {
  private readonly intervalMs: number;
  private readonly readSnapshot: () => Promise<StatusSnapshot>;
  private readonly publish: () => void;
  private readonly hasListeners: () => boolean;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private probing = false;
  /** The last health state clients were told about; null until one is known. */
  private fingerprint: string | null = null;

  constructor(options: SystemHealthWatcherOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.readSnapshot = options.readSnapshot;
    this.publish = options.publish ?? publishHealthChanged;
    this.hasListeners = options.hasListeners
      ?? (() => getSocketService()?.hasConnectedClients() ?? false);
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.probeOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One probe. Publishes when the health state moved, and returns whether it
   * published.
   */
  async probeOnce(): Promise<boolean> {
    // A slow dependency must not stack up probes behind the interval.
    if (this.closed || this.probing) return false;
    // With nobody connected there is no one to tell; a client that connects
    // later reconciles on connect.
    if (!this.hasListeners()) return false;
    this.probing = true;
    let fingerprint: string;
    try {
      fingerprint = healthFingerprint(await this.readSnapshot());
    } catch {
      // A failed read is not evidence that health changed; the surfaces keep
      // showing their last good snapshot until a probe succeeds.
      return false;
    } finally {
      this.probing = false;
    }
    if (this.closed) return false;
    const previous = this.fingerprint;
    this.fingerprint = fingerprint;
    if (previous === fingerprint) return false;
    // The first observed state is published too: a client that read health
    // before this probe may already be showing something older, and nothing
    // else would ever correct it while its socket stays connected.
    try {
      this.publish();
    } catch {
      // Freshness only; the probe itself succeeded.
    }
    return true;
  }
}
