export const PACKAGED_CONNECT_EVIDENCE_FAILURE_EVENT = 'packaged_connect.journey_evidence_failed';
export const PACKAGED_CONNECT_EXPECTED_DISCOVERY_COUNT = 10;

export const PACKAGED_CONNECT_EVIDENCE_FAILURE_CODES = Object.freeze([
  'DISCOVERY_COUNT_MISMATCH',
  'DISCOVERY_AUTHORIZATION_PRESENT',
  'PAIRING_START_MISSING',
  'PAIRING_START_DUPLICATE',
  'PAIRING_BROWSER_COUNT_MISMATCH',
  'PAIRING_EXPIRY_POLL_PRESENT',
  'PAIRING_CANCEL_POLL_PRESENT',
  'PAIRING_SUCCESS_POLL_COUNT_MISMATCH',
  'PAIRING_POLL_COUNT_MISMATCH',
  'PAIRING_ACTIVATION_COUNT_MISMATCH',
  'PAIRING_METHOD_MISMATCH',
  'PAIRING_BROWSER_CREDENTIAL_PRESENT',
  'PAIRING_INTENT_SEQUENCE_MISMATCH',
  'PAIRING_LIFECYCLE_ISOLATION_FAILED',
  'PAIRING_REQUEST_AFTER_TERMINAL',
  'DELAYED_APPROVAL_READINESS_MISSING',
  'BOOTSTRAP_AUTHORIZATION_PRESENT',
  'ACCOUNT_CONFIRMATION_COUNT_MISMATCH',
  'ACCOUNT_PROBE_COUNT_MISMATCH',
  'ACCOUNT_REQUEST_BOUNDARY_INVALID',
  'ACCOUNT_CONFIRMATION_ORDER_INVALID',
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

export const collectAcceptedSocketEvidence = ({ requests, authorization }) => {
  const authenticatedSockets = requests.filter(request =>
    request.socketIo === true
    && request.accepted === true
    && request.authorization === authorization);
  const socketScopes = new Set(authenticatedSockets.map(request => request.transportScope));
  return {
    authenticatedSocketCount: authenticatedSockets.length,
    socketHasNullScope: socketScopes.has(null),
    socketScopeBindingMismatch: authenticatedSockets.some(request =>
      request.socketQueryScopeCount !== 1 || request.socketAuthScope !== request.transportScope),
    socketScopeCount: socketScopes.size,
  };
};

export const collectPackagedConnectAccountEvidence = ({ requests, authorization }) => {
  const accounts = requests.filter(request => request.method !== 'OPTIONS'
    && request.url?.split('?')[0] === '/api/auth/user');
  const confirmations = accounts.filter(request => request.url === '/api/auth/user?desktop_account_confirmation=1');
  const probes = accounts.filter(request => request.url === '/api/auth/user');
  const activationIndex = requests.findIndex(request => request.method === 'POST' && request.url?.endsWith('/activate'));
  const confirmationIndex = requests.indexOf(confirmations[0]);
  return {
    accountConfirmationCount: confirmations.length,
    accountProbeCount: probes.length,
    accountRequestBoundaryValid: accounts.every(request => request.method === 'GET'
      && request.accountAccepted === true && request.authorization === authorization && request.transportScope === null),
    accountConfirmationOrderValid: activationIndex >= 0 && confirmationIndex > activationIndex
      && accounts.filter(request => request !== confirmations[0]).every(request => requests.indexOf(request) > confirmationIndex),
  };
};

const failureChecks = Object.freeze([
  // Pair contributes eight discoveries. The fresh reprobe process contributes
  // its profile probe plus the mandatory pre-Socket.IO identity gate.
  ['DISCOVERY_COUNT_MISMATCH', evidence =>
    evidence.discoveryCount !== PACKAGED_CONNECT_EXPECTED_DISCOVERY_COUNT],
  ['DISCOVERY_AUTHORIZATION_PRESENT', evidence => evidence.discoveryAuthorizationPresent],
  ['PAIRING_START_MISSING', evidence => evidence.pairingStartCount < 3],
  ['PAIRING_START_DUPLICATE', evidence => evidence.pairingStartCount > 3],
  ['PAIRING_BROWSER_COUNT_MISMATCH', evidence => evidence.pairingBrowserCount !== 3],
  ['PAIRING_EXPIRY_POLL_PRESENT', evidence => evidence.pairingExpiryPollPresent],
  ['PAIRING_CANCEL_POLL_PRESENT', evidence => evidence.pairingCancelPollPresent],
  ['PAIRING_SUCCESS_POLL_COUNT_MISMATCH', evidence => evidence.pairingSuccessPollCount !== 1],
  ['PAIRING_POLL_COUNT_MISMATCH', evidence => evidence.pairingPollCount !== 1],
  ['PAIRING_ACTIVATION_COUNT_MISMATCH', evidence => evidence.pairingActivationCount !== 1],
  ['PAIRING_METHOD_MISMATCH', evidence => !evidence.pairingMethodBoundaryValid],
  ['PAIRING_BROWSER_CREDENTIAL_PRESENT', evidence => evidence.pairingBrowserCredentialPresent],
  ['PAIRING_INTENT_SEQUENCE_MISMATCH', evidence => !evidence.pairingIntentSequenceValid],
  ['PAIRING_LIFECYCLE_ISOLATION_FAILED', evidence => !evidence.pairingLifecycleIsolated],
  ['PAIRING_REQUEST_AFTER_TERMINAL', evidence => evidence.pairingRequestAfterTerminal],
  ['DELAYED_APPROVAL_READINESS_MISSING', evidence => !evidence.delayedApprovalReadinessProven],
  ['BOOTSTRAP_AUTHORIZATION_PRESENT', evidence => evidence.bootstrapAuthorizationPresent],
  ['ACCOUNT_CONFIRMATION_COUNT_MISMATCH', evidence => evidence.accountConfirmationCount !== 1],
  ['ACCOUNT_PROBE_COUNT_MISMATCH', evidence => evidence.accountProbeCount < 2],
  ['ACCOUNT_REQUEST_BOUNDARY_INVALID', evidence => !evidence.accountRequestBoundaryValid],
  ['ACCOUNT_CONFIRMATION_ORDER_INVALID', evidence => !evidence.accountConfirmationOrderValid],
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
