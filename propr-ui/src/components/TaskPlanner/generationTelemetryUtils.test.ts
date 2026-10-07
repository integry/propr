import { describe, expect, it } from 'vitest';
import type { GenerationTrace } from '../../api/proprApi';
import { collectTelemetryFiles, getContextTokens, getDiscoveryFraction } from './generationTelemetryUtils';

const preview = {
  stats: { totalTokens: 840_000, costEstimate: 0, contextLength: 0, fileCount: 3 },
  smartSelection: [
    { path: 'src/b.ts', reason: '', source: 'auto' as const, score: 40 },
    { path: 'src/a.ts', reason: '', source: 'auto' as const, score: 80 },
    { path: 'lib.ts', reason: '', source: 'context-repo' as const, repository: 'integry/shared', score: 20 },
  ],
};
const trace = (steps: GenerationTrace['steps']): GenerationTrace => ({ steps });

describe('generation telemetry', () => {
  it('ranks discovered files by match relative to the best file', () => {
    expect(collectTelemetryFiles(undefined, preview)).toEqual([
      { path: 'src/a.ts', match: 100 },
      { path: 'src/b.ts', match: 50 },
      { path: 'integry/shared/lib.ts', match: 25 },
    ]);
  });

  it('prefers the trace candidates and appends included files neither source listed', () => {
    const files = collectTelemetryFiles(trace([
      { name: 'relevance', status: 'completed', data: { candidates: [{ path: 'x.ts', score: 10 }] } },
      { name: 'context', status: 'completed', data: { includedFiles: ['x.ts', 'y.ts'] } },
    ]), preview);
    expect(files).toEqual([{ path: 'x.ts', match: 100 }, { path: 'y.ts' }]);
  });

  it('advances discovery through relevance and context, and completes once context is assembled', () => {
    const now = Date.parse('2026-10-07T10:00:00Z');
    const startedAt = new Date(now - 15_000).toISOString();
    expect(getDiscoveryFraction(trace([{ name: 'relevance', status: 'in_progress', data: { startedAt, estimatedDuration: 30_000 } }]), now)).toBeCloseTo(0.2);
    expect(getDiscoveryFraction(trace([
      { name: 'relevance', status: 'completed' },
      { name: 'context', status: 'in_progress', data: { startedAt, estimatedDuration: 30_000 } },
    ]), now)).toBeCloseTo(0.7);
    expect(getDiscoveryFraction(trace([{ name: 'context', status: 'completed' }, { name: 'llm', status: 'in_progress' }]), now)).toBe(1);
  });

  it('uses the exact context size once reported, otherwise the preview estimate', () => {
    expect(getContextTokens(undefined, preview)).toEqual({ tokens: 840_000, exact: false });
    expect(getContextTokens(trace([{ name: 'context', status: 'completed', data: { tokenCount: 912_000 } }]), preview)).toEqual({ tokens: 912_000, exact: true });
    expect(getContextTokens(undefined, null)).toBeNull();
  });
});
