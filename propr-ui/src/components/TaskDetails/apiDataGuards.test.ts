import { describe, expect, it } from 'vitest';
import { isLogFilesData } from './apiDataGuards';

describe('task details API data guards', () => {
  it('accepts valid log-file payloads and rejects malformed entries', () => {
    expect(isLogFilesData({ sessionId: 'session-1', files: { stdout: '/logs/out' } })).toBe(true);
    expect(isLogFilesData({ logFiles: [{ name: 'out.log', path: '/logs/out', size: 12, type: 'stdout' }] })).toBe(true);
    expect(isLogFilesData({ error: 'Logs are unavailable' })).toBe(true);
    expect(isLogFilesData({ sessionId: null, files: null, error: 'Logs are unavailable' })).toBe(true);
    expect(isLogFilesData({ sessionId: null, files: { stdout: '/logs/out' }, error: 'warning' })).toBe(false);
    expect(isLogFilesData({})).toBe(false);
    expect(isLogFilesData({ files: { stdout: '/logs/out' } })).toBe(false);
    expect(isLogFilesData({ files: { stdout: 42 } })).toBe(false);
    expect(isLogFilesData({ logFiles: [{ name: 'out.log' }] })).toBe(false);
    expect(isLogFilesData([])).toBe(false);
  });

});
