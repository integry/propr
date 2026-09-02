export const PACKAGED_ACCEPTANCE_CURRENT_USER_PREFIX = '[ProPR Acceptance Current User]';

export type PackagedAcceptanceCurrentUserPhase =
  | 'request-issued'
  | 'response-completed'
  | 'parsed-user-accepted'
  | 'parsed-user-rejected'
  | 'active-scope-accepted'
  | 'stale-scope-rejected'
  | 'revoked-scope-rejected'
  | 'active-scope-rejected';

export type PackagedAcceptanceCurrentUserClassification =
  | 'pending'
  | 'success'
  | 'unauthenticated'
  | 'revoked'
  | 'forbidden'
  | 'server-error'
  | 'network-error'
  | 'invalid-schema';

export interface PackagedAcceptanceCurrentUserEvidence {
  schemaVersion: 1;
  correlation: 'current-scope-user-validation';
  phase: PackagedAcceptanceCurrentUserPhase;
  scopeGeneration: number;
  activeScopePresent: boolean;
  responseStatus: number;
  classification: PackagedAcceptanceCurrentUserClassification;
  schemaAccepted: boolean;
}

type AcceptanceWindow = Window & {
  __PROPR_PACKAGED_ACCEPTANCE__?: unknown;
};

const REPORT_LIMIT = 10;
let reportCount = 0;

const acceptanceEvidenceEnabled = (): boolean => typeof window !== 'undefined'
  && typeof (window as AcceptanceWindow).__PROPR_PACKAGED_ACCEPTANCE__ === 'object'
  && (window as AcceptanceWindow).__PROPR_PACKAGED_ACCEPTANCE__ !== null;

export const reportPackagedAcceptanceCurrentUser = (
  evidence: Omit<PackagedAcceptanceCurrentUserEvidence, 'schemaVersion' | 'correlation'>,
): void => {
  if (!acceptanceEvidenceEnabled() || reportCount >= REPORT_LIMIT) return;
  reportCount += 1;
  console.info(PACKAGED_ACCEPTANCE_CURRENT_USER_PREFIX, {
    schemaVersion: 1,
    correlation: 'current-scope-user-validation',
    ...evidence,
  });
};
