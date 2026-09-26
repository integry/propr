import type { Server } from 'socket.io';
import { loadAgentTankSettings } from '@propr/core';
import { ACTIVITY_UPDATE, USAGE_UPDATE } from '@propr/shared';
import { ACTIVITY_ROOM } from './activitySocketRooms.js';

// Agent Tank and runtime health have no external push API. Sample once per API
// process while subscribed, then emit only changes; browser count adds no reads.
export class ShellActivityBroadcaster {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private closed = false;
  private fingerprints = new Map<string, string>();
  constructor(private io: Server, private readStatus?: () => Promise<Record<string, unknown>>,
    private readUsage = async (): Promise<unknown> => {
      const settings = await loadAgentTankSettings();
      if (!settings.enabled) return { enabled: false };
      const response = await fetch(`${settings.url}/status`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Agent Tank status: ${response.status}`);
      return response.json();
    }) {}

  start(): void {
    this.timer = setInterval(() => { void this.sample(); }, 30_000);
    this.timer.unref();
  }

  async sample(): Promise<void> {
    if (this.closed || this.running || !this.io.sockets.adapter.rooms.get(ACTIVITY_ROOM)?.size) return;
    this.running = true;
    try {
      await Promise.all([
        this.changed('usage', this.readUsage, () => this.io.to(ACTIVITY_ROOM).emit(USAGE_UPDATE,
          { eventType: USAGE_UPDATE, source: 'agent-tank', occurredAt: new Date().toISOString() })),
        this.readStatus ? this.changed('system', this.readStatus, () => this.io.to(ACTIVITY_ROOM).emit(ACTIVITY_UPDATE,
          { eventType: ACTIVITY_UPDATE, domain: 'system', change: 'progressed', entityId: 'system',
            repository: null, terminal: false, occurredAt: new Date().toISOString() })) : Promise.resolve(),
      ]);
    } finally { this.running = false; }
  }

  private async changed(key: string, read: () => Promise<unknown>, emit: () => void): Promise<void> {
    try {
      const snapshot = await read();
      if (this.closed) return;
      // Snapshot timestamps/countdowns are not resource changes.
      const fingerprint = JSON.stringify(snapshot, (name, value) =>
        ['timestamp', 'updatedAt', 'lastUpdated', 'fetchedAt', 'resetsIn', 'lastAckAt'].includes(name) ? undefined : value);
      if (this.fingerprints.get(key) === fingerprint) return;
      this.fingerprints.set(key, fingerprint);
      emit();
    } catch (error) { console.warn(`Unable to sample ${key} activity:`, error); }
  }

  close(): void { this.closed = true; clearInterval(this.timer); }
}
