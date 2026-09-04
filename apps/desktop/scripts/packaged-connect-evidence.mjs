export const PACKAGED_CONNECT_EVIDENCE_FAILURE_EVENT = 'packaged_connect.journey_evidence_failed';
export const PACKAGED_CONNECT_EXPECTED_DISCOVERY_COUNT = 10;

export const PACKAGED_CONNECT_EVIDENCE_FAILURE_CODES = Object.freeze([
  'DISCOVERY_COUNT_MISMATCH',
  'DISCOVERY_AUTHORIZATION_PRESENT',
  'PAIRING_START_COUNT_MISMATCH',
  'PAIRING_BROWSER_COUNT_MISMATCH',
  'PAIRING_POLL_COUNT_MISMATCH',
  'PAIRING_ACTIVATION_COUNT_MISMATCH',
  'BOOTSTRAP_AUTHORIZATION_PRESENT',
  'AUTHENTICATED_REST_COUNT_MISMATCH',
  'AUTHENTICATED_SOCKET_COUNT_MISMATCH',
  'REST_SCOPE_MISMATCH',
  'SOCKET_SCOPE_MISSING',
  'SOCKET_SCOPE_BINDING_MISMATCH',
  'SOCKET_SCOPE_ROTATION_MISMATCH',
  'PLAINTEXT_CREDENTIAL_PERSISTED',
  'PUBLIC_IDENTITY_MISSING',
  'PUBLIC_IDENTITY_ORDER_MISMATCH',
]);

const failureChecks = Object.freeze([
  // Pair contributes eight discoveries. The fresh reprobe process contributes
  // its profile probe plus the mandatory pre-Socket.IO identity gate.
  ['DISCOVERY_COUNT_MISMATCH', evidence =>
    evidence.discoveryCount !== PACKAGED_CONNECT_EXPECTED_DISCOVERY_COUNT],
  ['DISCOVERY_AUTHORIZATION_PRESENT', evidence => evidence.discoveryAuthorizationPresent],
  ['PAIRING_START_COUNT_MISMATCH', evidence => evidence.pairingStartCount !== 3],
  ['PAIRING_BROWSER_COUNT_MISMATCH', evidence => evidence.pairingBrowserCount !== 3],
  ['PAIRING_POLL_COUNT_MISMATCH', evidence => evidence.pairingPollCount !== 1],
  ['PAIRING_ACTIVATION_COUNT_MISMATCH', evidence => evidence.pairingActivationCount !== 1],
  ['BOOTSTRAP_AUTHORIZATION_PRESENT', evidence => evidence.bootstrapAuthorizationPresent],
  ['AUTHENTICATED_REST_COUNT_MISMATCH', evidence => evidence.authenticatedRestCount < 2],
  ['AUTHENTICATED_SOCKET_COUNT_MISMATCH', evidence => evidence.authenticatedSocketCount < 2],
  ['REST_SCOPE_MISMATCH', evidence => evidence.restScopeCount !== 1 || !evidence.restHasOnlyNullScope],
  ['SOCKET_SCOPE_MISSING', evidence => evidence.socketHasNullScope],
  ['SOCKET_SCOPE_BINDING_MISMATCH', evidence => evidence.socketScopeBindingMismatch],
  ['SOCKET_SCOPE_ROTATION_MISMATCH', evidence => evidence.socketScopeCount < 2],
  ['PLAINTEXT_CREDENTIAL_PERSISTED', evidence => evidence.plaintextCredentialPersisted],
  ['PUBLIC_IDENTITY_MISSING', evidence => evidence.firstIdentityIndex < 0],
  ['PUBLIC_IDENTITY_ORDER_MISMATCH', evidence => evidence.firstBearerIndex <= evidence.firstIdentityIndex],
]);

/** Return only the first fixed, secret-free failed invariant in protocol order. */
export const evaluatePackagedConnectEvidence = evidence => {
  const failed = failureChecks.find(([, check]) => check(evidence));
  if (!failed) return null;
  return {
    event: PACKAGED_CONNECT_EVIDENCE_FAILURE_EVENT,
    code: failed[0],
  };
};
