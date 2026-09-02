import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const PACKAGED_SMOKE_EVIDENCE_FILE = 'application.smoke-evidence.jsonl';

export const PACKAGED_SMOKE_EVIDENCE_EVENTS = [
  'desktop.smoke.authorized',
  'desktop.app.ready',
  'desktop.renderer.mvp_flows.ready',
  'desktop.renderer.layout.ready',
  'desktop.native.reduced_window.ready',
  'desktop.renderer.ready',
  'desktop.app.shutdown',
  'desktop.app.start_failed',
  'desktop.main_process.uncaught_exception',
  'desktop.log.write_failed',
] as const;

export const PACKAGED_CONNECT_SMOKE_EVIDENCE_EVENTS = [
  'desktop.renderer.connect_discovery.proof',
  'desktop.renderer.connect_discovery.ready',
] as const;

export type PackagedSmokeEvidenceEvent =
  | typeof PACKAGED_SMOKE_EVIDENCE_EVENTS[number]
  | typeof PACKAGED_CONNECT_SMOKE_EVIDENCE_EVENTS[number];

const allowedEvents = new Set<string>([
  ...PACKAGED_SMOKE_EVIDENCE_EVENTS,
  ...PACKAGED_CONNECT_SMOKE_EVIDENCE_EVENTS,
]);

export interface PackagedSmokeEvidenceSink {
  write(event: string): void;
  close(): void;
}

export const createPackagedSmokeEvidenceSink = (
  authorizedUserDataDirectory: string | null,
): PackagedSmokeEvidenceSink | null => {
  if (authorizedUserDataDirectory === null) return null;

  const evidencePath = join(authorizedUserDataDirectory, PACKAGED_SMOKE_EVIDENCE_FILE);
  const descriptor = openSync(evidencePath, 'wx', 0o600);
  let closed = false;
  const emitted = new Set<string>();
  try {
    const stats = fstatSync(descriptor);
    const pathStats = lstatSync(evidencePath);
    if (!stats.isFile() || !pathStats.isFile() || pathStats.isSymbolicLink()
      || pathStats.dev !== stats.dev || pathStats.ino !== stats.ino) {
      throw new Error('Packaged desktop smoke evidence must be one fixed regular non-link file');
    }
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }

  return {
    write(event: string): void {
      if (closed) throw new Error('Packaged desktop smoke evidence is closed');
      if (!allowedEvents.has(event) || emitted.has(event)) return;

      const record = Buffer.from(`${JSON.stringify({ event })}\n`, 'utf8');
      let offset = 0;
      while (offset < record.byteLength) {
        const written = writeSync(descriptor, record, offset, record.byteLength - offset);
        if (written <= 0) throw new Error('Packaged desktop smoke evidence write did not progress');
        offset += written;
      }
      fsyncSync(descriptor);
      emitted.add(event);
    },
    close(): void {
      if (closed) return;
      closeSync(descriptor);
      closed = true;
    },
  };
};
