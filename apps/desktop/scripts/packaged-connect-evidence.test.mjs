import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  collectAcceptedSocketEvidence,
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
  pairingPollCount: 1,
  pairingActivationCount: 1,
  pairingMethodBoundaryValid: true,
  pairingBrowserCredentialPresent: false,
  pairingIntentSequenceValid: true,
  pairingLifecycleIsolated: true,
  pairingRequestAfterTerminal: false,
  delayedApprovalReadinessProven: true,
  bootstrapAuthorizationPresent: false,
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
  PAIRING_POLL_COUNT_MISMATCH: { pairingPollCount: 2 },
  PAIRING_ACTIVATION_COUNT_MISMATCH: { pairingActivationCount: 2 },
  PAIRING_METHOD_MISMATCH: { pairingMethodBoundaryValid: false },
  PAIRING_BROWSER_CREDENTIAL_PRESENT: { pairingBrowserCredentialPresent: true },
  PAIRING_INTENT_SEQUENCE_MISMATCH: { pairingIntentSequenceValid: false },
  PAIRING_LIFECYCLE_ISOLATION_FAILED: { pairingLifecycleIsolated: false },
  PAIRING_REQUEST_AFTER_TERMINAL: { pairingRequestAfterTerminal: true },
  DELAYED_APPROVAL_READINESS_MISSING: { delayedApprovalReadinessProven: false },
  BOOTSTRAP_AUTHORIZATION_PRESENT: { bootstrapAuthorizationPresent: true },
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
