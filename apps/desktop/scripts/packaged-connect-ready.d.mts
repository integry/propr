export const CONNECT_READY_EVENT: 'desktop.renderer.connect_discovery.ready';
export const CONNECT_READY_MAX_BYTES: number;

export interface ConnectReadyExpected {
  platform: string;
  arch: string;
  authorityMechanism: string;
}

export interface ConnectReadyRecord {
  timestamp: string;
  level: 'info';
  event: typeof CONNECT_READY_EVENT;
  selectedPlatform: string;
  selectedArch: string;
  authorityMechanism: string;
  rendererSchemaValid: true;
}

export type ConnectReadyPublication =
  | { ok: true; byteLength: number }
  | { ok: false; category: 'duplicate' | 'schema' | 'byte-bound' | 'broken-pipe' | 'zero-progress' };

export function isExactConnectReadyRecord(
  record: unknown,
  expected: ConnectReadyExpected,
): record is ConnectReadyRecord;

export function createConnectReadyRecord(
  expected: ConnectReadyExpected & { timestamp?: string },
): ConnectReadyRecord;

export function createConnectReadyPublisher(options?: {
  writeSync?: (fd: number, buffer: Buffer, offset: number, length: number) => number;
  maximumBytes?: number;
}): {
  publish(record: unknown, expected: ConnectReadyExpected): ConnectReadyPublication;
};
