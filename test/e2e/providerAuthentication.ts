/**
 * Recognizes an explicit provider account credential rejection in live E2E.
 * Generic authentication, HTTP 401, and GitHub errors remain test failures.
 */
export function isProviderAuthenticationFailure(
  finalState: string | null,
  failureReason: string | null,
): boolean {
  return finalState === "failed" && failureReason !== null &&
    /\bEncountered invalidated oauth token for user, failing request\b/i.test(failureReason);
}
