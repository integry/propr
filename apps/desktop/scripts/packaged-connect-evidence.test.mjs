import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  collectAcceptedSocketEvidence,
  collectPackagedConnectAccountEvidence,
  evaluatePackagedConnectEvidence,
  PACKAGED_CONNECT_EVIDENCE_FAILURE_CODES,
  PACKAGED_CONNECT_EVIDENCE_FAILURE_EVENT,
  PACKAGED_CONNECT_EXPECTED_DISCOVERY_COUNT,
} from './packaged-connect-evidence.mjs';

const passingEvidence = () => ({
  discoveryCount: PACKAGED_CONNECT_EXPECTED_DISCOVERY_COUNT,
  discoveryAuthorizationPresent: false,
  pairingStartCount: 3,
  pairingBrowserCount: 3,
  pairingExpiryPollPresent: false,
  pairingCancelPollPresent: false,
  pairingSuccessPollCount: 1,
  pairingPollCount: 1,
  pairingActivationCount: 1,
  pairingMethodBoundaryValid: true,
  pairingBrowserCredentialPresent: false,
  pairingIntentSequenceValid: true,
  pairingLifecycleIsolated: true,
  pairingRequestAfterTerminal: false,
  delayedApprovalReadinessProven: true,
  bootstrapAuthorizationPresent: false,
  accountConfirmationCount: 1,
  accountProbeCount: 2,
  accountRequestBoundaryValid: true,
  accountConfirmationOrderValid: true,
  authenticatedRestCount: 2,
  authenticatedSocketCount: 2,
  restScopeCount: 1,
  restHasOnlyNullScope: true,
  socketHasNullScope: false,
  socketScopeBindingMismatch: false,
  socketScopeCount: 2,
  plaintextCredentialPersisted: false,
  firstIdentityIndex: 1,
  firstBearerIndex: 2,
});

const failingEvidence = Object.freeze({
  DISCOVERY_COUNT_MISMATCH: { discoveryCount: 8 },
  DISCOVERY_AUTHORIZATION_PRESENT: { discoveryAuthorizationPresent: true },
  PAIRING_START_MISSING: { pairingStartCount: 2 },
  PAIRING_START_DUPLICATE: { pairingStartCount: 4 },
  PAIRING_BROWSER_COUNT_MISMATCH: { pairingBrowserCount: 2 },
  PAIRING_EXPIRY_POLL_PRESENT: { pairingExpiryPollPresent: true },
  PAIRING_CANCEL_POLL_PRESENT: { pairingCancelPollPresent: true },
  PAIRING_SUCCESS_POLL_COUNT_MISMATCH: { pairingSuccessPollCount: 2 },
  PAIRING_POLL_COUNT_MISMATCH: { pairingPollCount: 2 },
  PAIRING_ACTIVATION_COUNT_MISMATCH: { pairingActivationCount: 2 },
  PAIRING_METHOD_MISMATCH: { pairingMethodBoundaryValid: false },
  PAIRING_BROWSER_CREDENTIAL_PRESENT: { pairingBrowserCredentialPresent: true },
  PAIRING_INTENT_SEQUENCE_MISMATCH: { pairingIntentSequenceValid: false },
  PAIRING_LIFECYCLE_ISOLATION_FAILED: { pairingLifecycleIsolated: false },
  PAIRING_REQUEST_AFTER_TERMINAL: { pairingRequestAfterTerminal: true },
  DELAYED_APPROVAL_READINESS_MISSING: { delayedApprovalReadinessProven: false },
  BOOTSTRAP_AUTHORIZATION_PRESENT: { bootstrapAuthorizationPresent: true },
  ACCOUNT_CONFIRMATION_COUNT_MISMATCH: { accountConfirmationCount: 0 },
  ACCOUNT_PROBE_COUNT_MISMATCH: { accountProbeCount: 1 },
  ACCOUNT_REQUEST_BOUNDARY_INVALID: { accountRequestBoundaryValid: false },
  ACCOUNT_CONFIRMATION_ORDER_INVALID: { accountConfirmationOrderValid: false },
  AUTHENTICATED_REST_COUNT_MISMATCH: { authenticatedRestCount: 1 },
  AUTHENTICATED_SOCKET_COUNT_MISMATCH: { authenticatedSocketCount: 1 },
  REST_SCOPE_MISMATCH: { restScopeCount: 2 },
  SOCKET_SCOPE_MISSING: { socketHasNullScope: true },
  SOCKET_SCOPE_BINDING_MISMATCH: { socketScopeBindingMismatch: true },
  SOCKET_SCOPE_ROTATION_MISMATCH: { socketScopeCount: 1 },
  PLAINTEXT_CREDENTIAL_PERSISTED: { plaintextCredentialPersisted: true },
  PUBLIC_IDENTITY_MISSING: { firstIdentityIndex: -1 },
  PUBLIC_IDENTITY_ORDER_MISMATCH: { firstBearerIndex: 1 },
});

describe('packaged Connect aggregate evidence', () => {
  test('accepts the complete fixed protocol evidence', () => {
    assert.equal(evaluatePackagedConnectEvidence(passingEvidence()), null);
  });

  test('accepts valid rotated Socket.IO bindings alongside the expected stale-auth rejection', () => {
    const socketEvidence = collectAcceptedSocketEvidence({
      authorization: 'Bearer fixture-token',
      requests: [
        {
          socketIo: true,
          accepted: true,
          authorization: 'Bearer fixture-token',
          transportScope: 'scope-before-rotation',
          socketQueryScopeCount: 1,
          socketAuthScope: 'scope-before-rotation',
        },
        {
          socketIo: true,
          accepted: true,
          authorization: 'Bearer fixture-token',
          transportScope: 'scope-after-rotation',
          socketQueryScopeCount: 1,
          socketAuthScope: 'scope-after-rotation',
        },
        {
          socketIo: true,
          accepted: false,
          authorization: 'Bearer fixture-token',
          transportScope: 'scope-after-rotation',
          socketQueryScopeCount: 1,
          socketAuthScope: 'scope-before-rotation',
        },
      ],
    });

    assert.deepEqual(socketEvidence, {
      authenticatedSocketCount: 2,
      socketHasNullScope: false,
      socketScopeBindingMismatch: false,
      socketScopeCount: 2,
    });
    assert.equal(evaluatePackagedConnectEvidence({
      ...passingEvidence(),
      ...socketEvidence,
    }), null);
  });

  test('requires exactly eight pair discoveries and two fresh-process reprobe discoveries', () => {
    assert.equal(PACKAGED_CONNECT_EXPECTED_DISCOVERY_COUNT, 10);
    for (const discoveryCount of [8, 9, 11]) {
      assert.deepEqual(
        evaluatePackagedConnectEvidence({ ...passingEvidence(), discoveryCount }),
        {
          event: PACKAGED_CONNECT_EVIDENCE_FAILURE_EVENT,
          code: 'DISCOVERY_COUNT_MISMATCH',
        },
      );
    }
  });

  for (const code of PACKAGED_CONNECT_EVIDENCE_FAILURE_CODES) {
    test(`reports only fixed evidence for ${code}`, () => {
      const record = evaluatePackagedConnectEvidence({
        ...passingEvidence(),
        ...failingEvidence[code],
        hostileUrl: 'https://private.example.test/path',
        hostileToken: 'secret-SENTINEL',
        hostileCount: 9_999_999,
      });
      assert.deepEqual(record, {
        event: PACKAGED_CONNECT_EVIDENCE_FAILURE_EVENT,
        code,
      });
      assert.deepEqual(Object.keys(record).sort(), ['code', 'event']);
      assert.doesNotMatch(JSON.stringify(record), /private|secret|999/u);
    });
  }
});


test('account evidence requires activated confirmation before saved-account and renderer validation', () => {
  const authorization = 'Bearer fixture-token';
  const activation = { method: 'POST', url: '/api/desktop/pairings/test/activate' };
  const accountRequest = url => ({
    method: 'GET', url, authorization, transportScope: null, accountAccepted: true,
  });
  const confirmation = accountRequest('/api/auth/user?desktop_account_confirmation=1');
  const probe = accountRequest('/api/auth/user');
  const renderer = accountRequest('/api/auth/user?proprDesktopScopeGeneration=1');
  const requests = [activation, confirmation, probe, renderer, { ...probe }, { ...renderer }];
  const collect = requests => collectPackagedConnectAccountEvidence({ requests, authorization });
  const evaluate = requests => evaluatePackagedConnectEvidence({ ...passingEvidence(), ...collect(requests) })?.code;
  assert.equal(evaluate(requests), undefined);
  assert.equal(evaluate(requests.filter(request => request !== confirmation)), 'ACCOUNT_CONFIRMATION_COUNT_MISMATCH');
  assert.equal(evaluate([...requests, { ...confirmation }]), 'ACCOUNT_CONFIRMATION_COUNT_MISMATCH');
  assert.equal(evaluate(requests.filter(request => request !== probe)), 'ACCOUNT_PROBE_COUNT_MISMATCH');
  assert.equal(evaluate([confirmation, activation, ...requests.slice(2)]), 'ACCOUNT_CONFIRMATION_ORDER_INVALID');
  assert.equal(evaluate([activation, probe, confirmation, renderer, { ...probe }]), 'ACCOUNT_CONFIRMATION_ORDER_INVALID');
  for (const change of [
    { method: 'POST' }, { accountAccepted: false }, { authorization: null }, { transportScope: 'leaked-scope' },
  ]) {
    assert.equal(evaluate(requests.map(request => request === confirmation ? { ...request, ...change } : request)),
      'ACCOUNT_REQUEST_BOUNDARY_INVALID');
  }
  // Host confirmation and reprobes cannot substitute for renderer transport evidence.
  assert.equal(evaluatePackagedConnectEvidence({
    ...passingEvidence(), ...collect(requests), authenticatedRestCount: 0,
  })?.code, 'AUTHENTICATED_REST_COUNT_MISMATCH');
});
