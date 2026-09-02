import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DesktopWebSocketHandshakeEvidence } from './credential-service';

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

export type PackagedSmokeEvidenceEvent = typeof PACKAGED_SMOKE_EVIDENCE_EVENTS[number];

const allowedEvents = new Set<string>(PACKAGED_SMOKE_EVIDENCE_EVENTS);

export interface PackagedSmokeEvidenceSink {
  write(event: string): void;
  close(): void;
}

export const PACKAGED_SMOKE_HANDSHAKE_EVIDENCE_LIMIT = 8;

export interface PackagedSmokeHandshakeEvidenceBuffer {
  records: DesktopWebSocketHandshakeEvidence[];
  overflowed: boolean;
}

export interface PackagedStaleSocketBoundarySummary {
  schemaVersion: 1;
  mainAttempts: 2;
  staleRejectedByMain: true;
  staleRejectionCategory: 'stale-scope';
  freshAcceptedByMain: true;
  exactPath: true;
  exactTransport: true;
  exactResource: true;
  queryCount: 1;
  activeBindingPresent: true;
  profileGenerationCurrent: true;
  originEqualsActive: true;
  rendererBearerPresent: false;
  rendererCookiePresent: false;
  staleOutboundBearerPresent: false;
  staleBearerMainInjected: false;
  freshBearerMainInjected: true;
}

const exactHandshakeEvidence = (
  evidence: DesktopWebSocketHandshakeEvidence | undefined,
  expected: 'stale' | 'fresh',
): boolean => evidence?.schemaVersion === 1
  && evidence.path === 'socket-io'
  && evidence.transport === 'websocket'
  && evidence.resource === 'websocket'
  && evidence.scopeQueryPresent === true
  && evidence.scopeQueryCount === 1
  && evidence.scopeEqualsActive === (expected === 'fresh')
  && evidence.activeBindingPresent === true
  && evidence.profileGenerationCurrent === true
  && evidence.originEqualsActive === true
  && evidence.rendererBearerPresent === false
  && evidence.rendererCookiePresent === false
  && evidence.outboundBearerPresent === (expected === 'fresh')
  && evidence.bearerMainInjected === (expected === 'fresh')
  && evidence.accepted === (expected === 'fresh')
  && evidence.rejectionCategory === (expected === 'fresh' ? 'none' : 'stale-scope');

/** Validate one renderer stale reconnect followed by its distinct fresh Manager. */
export const validatePackagedStaleSocketBoundaryEvidence = (
  evidence: readonly DesktopWebSocketHandshakeEvidence[],
  overflowed: boolean,
): PackagedStaleSocketBoundarySummary => {
  if (overflowed || evidence.length !== 2
    || !exactHandshakeEvidence(evidence[0], 'stale')
    || !exactHandshakeEvidence(evidence[1], 'fresh')) {
    throw new Error('Packaged stale Socket.IO main-boundary evidence failed');
  }
  return {
    schemaVersion: 1,
    mainAttempts: 2,
    staleRejectedByMain: true,
    staleRejectionCategory: 'stale-scope',
    freshAcceptedByMain: true,
    exactPath: true,
    exactTransport: true,
    exactResource: true,
    queryCount: 1,
    activeBindingPresent: true,
    profileGenerationCurrent: true,
    originEqualsActive: true,
    rendererBearerPresent: false,
    rendererCookiePresent: false,
    staleOutboundBearerPresent: false,
    staleBearerMainInjected: false,
    freshBearerMainInjected: true,
  };
};

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
