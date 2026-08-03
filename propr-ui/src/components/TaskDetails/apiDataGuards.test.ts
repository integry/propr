import { describe, expect, it } from 'vitest';
import { isAnalysisData, isLogFilesData } from './apiDataGuards';

describe('task details API data guards', () => {
  it('accepts valid log-file payloads and rejects malformed entries', () => {
    expect(isLogFilesData({ sessionId: 'session-1', files: { stdout: '/logs/out' } })).toBe(true);
    expect(isLogFilesData({ logFiles: [{ name: 'out.log', path: '/logs/out', size: 12, type: 'stdout' }] })).toBe(true);
    expect(isLogFilesData({ files: { stdout: 42 } })).toBe(false);
    expect(isLogFilesData({ logFiles: [{ name: 'out.log' }] })).toBe(false);
    expect(isLogFilesData([])).toBe(false);
  });

  it('accepts only string-valued analysis fields', () => {
    expect(isAnalysisData({ report: 'summary', content: 'details' })).toBe(true);
    expect(isAnalysisData({ analysis: ['unexpected'] })).toBe(false);
    expect(isAnalysisData(null)).toBe(false);
  });
});
