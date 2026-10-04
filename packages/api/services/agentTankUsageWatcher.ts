import * as configManager from '@propr/core';
import { agentTankUsageFingerprint, type AgentTankSettings, type AgentStatusResponse } from '@propr/core';
import { USAGE_UPDATE } from '@propr/shared';
import { getSocketService } from './socketService.js';

/**
 * Watches Agent Tank for quota movement so the sidebar does not have to.
 *
 * Provider quotas move inside Agent Tank, which has no way to call us, so
 * something has to look. Before, every open sidebar looked for itself once a
 * minute; now this instance looks once and tells the clients only when what
 * they are showing actually changed. The event is a bare trigger: each client
 * re-reads `/api/config/agent-tank/usage`, which keeps owning the projection
 * and its permission check.
 */

const DEFAULT_PROBE_INTERVAL_MS = 60_000;

export interface AgentTankUsageWatcherOptions {
  intervalMs?: number;
  /** Test seam; production reads the stored Agent Tank settings. */
  loadSettings?: () => Promise<Pick<AgentTankSettings, 'mode' | 'url'>>;
  /** Test seam; production reads the provider snapshot Agent Tank exposes. */
  readStatuses?: () => Promise<Record<string, AgentStatusResponse> | undefined>;
  /** Test seam; production broadcasts to this instance's operational clients. */
  publish?: () => void;
  /** Whether anyone is connected to be told. */
  hasListeners?: () => boolean;
}

function publishUsageChanged(): void {
  getSocketService()?.broadcastPushEvent({
    eventType: USAGE_UPDATE,
    occurredAt: new Date().toISOString()
  });
}

export class AgentTankUsageWatcher {
  private readonly intervalMs: number;
  private readonly loadSettings: () => Promise<Pick<AgentTankSettings, 'mode' | 'url'>>;
  private readonly readStatuses: () => Promise<Record<string, AgentStatusResponse> | undefined>;
  private readonly publish: () => void;
  private readonly hasListeners: () => boolean;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private probing = false;
  /** The last snapshot clients were able to read; null until one is known. */
  private snapshot: string | null = null;

  constructor(options: AgentTankUsageWatcherOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.loadSettings = options.loadSettings
      ?? (() => configManager.loadAgentTankSettings());
    this.readStatuses = options.readStatuses ?? (() => configManager.getAgentTankStatuses());
    this.publish = options.publish ?? publishUsageChanged;
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
   * One probe. Publishes only when the snapshot moved, so an idle instance
   * costs its clients nothing, and returns whether it published.
   */
  async probeOnce(): Promise<boolean> {
    // A slow Agent Tank must not stack up probes behind the interval.
    if (this.closed || this.probing) return false;
    // With nobody connected there is no one to tell, and the snapshot kept here
    // would only go stale; a client that connects later reconciles on connect.
    if (!this.hasListeners()) return false;
    this.probing = true;
    let snapshot: string | null;
    try {
      snapshot = await this.readSnapshot();
    } finally {
      this.probing = false;
    }
    if (snapshot === null || this.closed) return false;
    const previous = this.snapshot;
    this.snapshot = snapshot;
    if (previous === snapshot) return false;
    // The first snapshot observed with listeners is published too. A sidebar
    // that mounted before this probe read whatever Agent Tank showed then; if
    // the quota moved in between, suppressing this would leave that sidebar
    // showing the old value forever, because every later probe sees the same
    // snapshot and stays silent.
    try {
      this.publish();
    } catch {
      // Freshness only; the probe itself succeeded.
    }
    return true;
  }

  /** The current usage snapshot, or null when it could not be read at all. */
  private async readSnapshot(): Promise<string | null> {
    let settings: Pick<AgentTankSettings, 'mode' | 'url'>;
    try {
      settings = await this.loadSettings();
    } catch {
      return null;
    }
    if (settings.mode === 'disabled') return 'disabled';
    // A retained external URL is irrelevant to bundled observations.
    const source = settings.mode === 'external' ? settings.url : 'bundled';
    try {
      const status = await this.readStatuses();
      // Preserve provider membership and errors, but ignore countdowns and
      // refresh timestamps just like the other Agent Tank observers.
      const fingerprint = status && typeof status === 'object'
        ? Object.entries(status as Record<string, AgentStatusResponse>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, agent]) => [name, agentTankUsageFingerprint({ ...agent, name: agent.name || name })])
        : 'unreachable';
      return JSON.stringify({ source, status: fingerprint });
    } catch {
      // An unreachable Agent Tank is itself a change the sidebar shows.
      return JSON.stringify({ source, status: 'unreachable' });
    }
  }
}
