import type { GenerationTrace, PreviewResult } from '../../api/proprApi';

export interface TelemetryFile {
  path: string;
  /** Match against the prompt, 0-100, relative to the best-scoring file. */
  match?: number;
}

type TraceStep = GenerationTrace['steps'][number];
export type TelemetryPreview = Pick<PreviewResult, 'smartSelection' | 'stats'> | null | undefined;

const findStep = (trace: GenerationTrace | undefined, name: string): TraceStep | undefined =>
  trace?.steps?.find(step => step.name === name);

const isDone = (step: TraceStep | undefined) => step?.status === 'completed';

/**
 * Files the generation run discovers, best match first. The trace's own relevance candidates win;
 * otherwise the last context preview (the same selection the run reuses) supplies paths and scores,
 * and the context step's included files fill in anything neither listed.
 */
export function collectTelemetryFiles(trace: GenerationTrace | undefined, preview: TelemetryPreview): TelemetryFile[] {
  const candidates = findStep(trace, 'relevance')?.data?.candidates;
  const scored: Array<{ path: string; score?: number }> = Array.isArray(candidates) && candidates.length > 0
    ? candidates
    : (preview?.smartSelection ?? []).map(file => ({ path: file.repository ? `${file.repository}/${file.path}` : file.path, score: file.score }));
  const included = findStep(trace, 'context')?.data?.includedFiles;
  const seen = new Set(scored.map(file => file.path));
  const extra: TelemetryFile[] = Array.isArray(included) ? (included as string[]).filter(path => !seen.has(path)).map(path => ({ path })) : [];
  const maxScore = Math.max(1, ...scored.map(file => file.score ?? 0));
  return [...scored]
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1))
    .map((file): TelemetryFile => ({ path: file.path, match: file.score == null ? undefined : Math.round(Math.min(100, Math.max(0, (file.score / maxScore) * 100))) }))
    .concat(extra);
}

/** True once the run's relevance step has reported its own candidates (not the last preview's). */
export function hasReportedCandidates(trace: GenerationTrace | undefined): boolean {
  const candidates = findStep(trace, 'relevance')?.data?.candidates;
  return Array.isArray(candidates) && candidates.length > 0;
}

/** True while the listed files are the last preview's selection rather than anything the run reported. */
export function isPreviewDerived(trace: GenerationTrace | undefined, fileCount: number, contextDone: boolean): boolean {
  return fileCount > 0 && !contextDone && !hasReportedCandidates(trace);
}

/** How far discovery has got, 0-1: relevance ranking is the first 40%, compiling context the rest. */
export function getDiscoveryFraction(trace: GenerationTrace | undefined, now: number): number {
  const relevance = findStep(trace, 'relevance');
  const context = findStep(trace, 'context');
  if (isDone(context) || findStep(trace, 'llm')?.status === 'in_progress' || isDone(findStep(trace, 'llm'))) return 1;
  const stepFraction = (step: TraceStep | undefined) => {
    const startedAt = Date.parse(String(step?.data?.startedAt ?? ''));
    const estimate = Number(step?.data?.estimatedDuration);
    if (step?.status !== 'in_progress' || !Number.isFinite(startedAt) || !(estimate > 0)) return 0;
    return Math.min(0.95, Math.max(0, (now - startedAt) / estimate));
  };
  if (context?.status === 'in_progress') return 0.4 + 0.6 * stepFraction(context);
  if (isDone(relevance)) return 0.4;
  return 0.4 * stepFraction(relevance);
}

/** The context size: exact once the context step reports it, otherwise the last preview's estimate. */
export function getContextTokens(trace: GenerationTrace | undefined, preview: TelemetryPreview): { tokens: number; exact: boolean } | null {
  const exact = Number(findStep(trace, 'context')?.data?.tokenCount);
  if (exact > 0) return { tokens: exact, exact: true };
  const estimate = preview?.stats?.totalTokens;
  return estimate && estimate > 0 ? { tokens: estimate, exact: false } : null;
}
