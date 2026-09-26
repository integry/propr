import { describe, expect, it } from 'vitest';
import { isAnalysisData, isLogFilesData, normalizeAnalysisData } from './apiDataGuards';

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

  it('accepts only string-valued analysis fields', () => {
    expect(isAnalysisData({ report: 'summary', content: 'details' })).toBe(true);
    expect(isAnalysisData({ report: 'summary', analysis: null, content: null, error: null })).toBe(true);
    expect(normalizeAnalysisData({ report: 'summary', analysis: null, content: null, error: null })).toEqual({
      report: 'summary',
      analysis: undefined,
      content: undefined,
      error: undefined,
    });
    expect(isAnalysisData({ analysis: null })).toBe(false);
    expect(isAnalysisData({})).toBe(false);
    expect(isAnalysisData({ unrelated: 42 })).toBe(false);
    expect(isAnalysisData({ report: '' })).toBe(false);
    expect(isAnalysisData({ report: 'summary', unrelated: 42 })).toBe(true);
    expect(isAnalysisData({ analysis: ['unexpected'] })).toBe(false);
    expect(isAnalysisData(null)).toBe(false);
  });
});
