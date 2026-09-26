/**
 * Classifies model task failures caused by exhausted provider credits or quotas.
 *
 * These failures come from the provider account used by the live E2E runner
 * (for example "You've hit your usage limit" from Codex), not from ProPR, so the
 * model matrix reports them instead of failing the nightly run.
 */

const PROVIDER_USAGE_LIMIT_PATTERNS = [
  /usage limit/i,
  /out of quota/i,
  /insufficient[_ ]quota/i,
  /credit balance/i,
  /purchase more credits/i,
  /billing hard limit/i,
  /monthly budget/i,
];

export function isProviderUsageLimitFailure(finalState: string | null, failureReason: string | null): boolean {
  if (finalState !== "failed" || !failureReason) return false;
  return PROVIDER_USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(failureReason));
}
