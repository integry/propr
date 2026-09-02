import { writeSync as nodeWriteSync } from 'node:fs';

export const CONNECT_READY_EVENT = 'desktop.renderer.connect_discovery.ready';
export const CONNECT_READY_MAX_BYTES = 1024;

const exactKeys = (record, expected) => {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const isExactConnectReadyRecord = (record, { platform, arch, authorityMechanism }) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (!exactKeys(record, [
    'authorityMechanism', 'event', 'level', 'rendererSchemaValid',
    'selectedArch', 'selectedPlatform', 'timestamp',
  ])) return false;
  return record.event === CONNECT_READY_EVENT
    && record.level === 'info'
    && typeof record.timestamp === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.timestamp)
    && record.selectedPlatform === platform
    && record.selectedArch === arch
    && record.authorityMechanism === authorityMechanism
    && record.rendererSchemaValid === true;
};

export const createConnectReadyRecord = ({
  platform,
  arch,
  authorityMechanism,
  timestamp = new Date().toISOString(),
}) => ({
  timestamp,
  level: 'info',
  event: CONNECT_READY_EVENT,
  selectedPlatform: platform,
  selectedArch: arch,
  authorityMechanism,
  rendererSchemaValid: true,
});

/**
 * Publish the smoke-only READY authority once through fd 1. The result contains
 * only fixed classifications: OS error details and written bytes never escape.
 */
export const createConnectReadyPublisher = ({
  writeSync = nodeWriteSync,
  maximumBytes = CONNECT_READY_MAX_BYTES,
} = {}) => {
  let attempted = false;
  return {
    publish(record, expected) {
      if (attempted) return { ok: false, category: 'duplicate' };
      attempted = true;
      if (!isExactConnectReadyRecord(record, expected)) {
        return { ok: false, category: 'schema' };
      }
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      if (bytes.byteLength <= 1 || bytes.byteLength > maximumBytes) {
        return { ok: false, category: 'byte-bound' };
      }
      let offset = 0;
      while (offset < bytes.byteLength) {
        let written;
        try {
          written = writeSync(1, bytes, offset, bytes.byteLength - offset);
        } catch {
          return { ok: false, category: 'broken-pipe' };
        }
        if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - offset) {
          return { ok: false, category: 'zero-progress' };
        }
        offset += written;
      }
      return { ok: true, byteLength: bytes.byteLength };
    },
  };
};
