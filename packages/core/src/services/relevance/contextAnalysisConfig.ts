export const DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS = 30 * 60 * 1000;

/** Resolve the relevance-analysis deadline, falling back safely on invalid input. */
export function resolveContextAnalysisTimeoutMs(
  configuredValue: string | undefined = process.env.CONTEXT_ANALYSIS_TIMEOUT_MS
): number {
  if (!configuredValue?.trim()) return DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS;

  const parsed = Number.parseInt(configuredValue, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS;
}
