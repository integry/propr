const PROVIDER_CREDENTIAL_REJECTIONS = [
  /\bEncountered invalidated oauth token for user, failing request\b/i,
  /\bFailed to authenticate: OAuth session expired and could not be refreshed\b/i,
];

/**
 * Recognizes an explicit provider account credential rejection in live E2E.
 * Generic authentication, HTTP 401, and GitHub errors remain test failures.
 */
export function isProviderAuthenticationFailure(
  finalState: string | null,
  failureReason: string | null,
): boolean {
  return finalState === "failed" && failureReason !== null &&
    PROVIDER_CREDENTIAL_REJECTIONS.some((pattern) => pattern.test(failureReason));
}
