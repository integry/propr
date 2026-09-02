import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyCurrentUserRequestShape,
  currentUserValidationPhaseSummary,
  currentUserValidationFailureCategory,
  networkPermissionDecisionSummary,
  scopedCurrentUserRequestGeneration,
} from './packaged-acceptance-current-user.mjs';

const journey = 'dashboard-profile-manager';
const rendererRecords = [
  { journey, activeScopePresent: true, scopeGeneration: 1, phase: 'request-issued' },
  {
    journey, activeScopePresent: true, scopeGeneration: 1, phase: 'response-completed',
    responseStatus: 200, classification: 'success',
  },
  {
    journey, activeScopePresent: true, scopeGeneration: 1, phase: 'parsed-user-accepted', schemaAccepted: true,
  },
  { journey, activeScopePresent: true, scopeGeneration: 1, phase: 'active-scope-accepted' },
];
const acceptedMain = {
  journey,
  rendererScopeGeneration: 1,
  scopeGenerationQueryCount: 1,
  scopeGenerationQueryValid: true,
  scopeHeaderCount: 1,
  activeBindingPresent: true,
  activeScopeGeneration: 0,
  profileGenerationCurrent: true,
  scopeEqualsActive: true,
  originEqualsActive: true,
  rendererBearerPresent: false,
  rendererCookiePresent: false,
  outboundBearerPresent: true,
  bearerMainInjected: true,
  accepted: true,
  rejectionCategory: 'none',
};
const fixtureRecords = [{
  journey,
  source: 'renderer',
  scopeGeneration: 1,
  requestArrived: true,
  authorizationPresent: true,
  authorizationMatchesActivatedBearer: true,
  cookiePresent: false,
  responseStatus: 200,
}];
const classify = mainRecord => currentUserValidationFailureCategory({
  journey,
  evidenceInvalid: false,
  rendererRecords,
  mainRecords: [mainRecord],
  fixtureRecords,
});

describe('packaged scoped current-user request URL', () => {
  it('accepts one canonical bounded desktop generation parameter', () => {
    assert.equal(scopedCurrentUserRequestGeneration(
      'GET', '/api/auth/user?proprDesktopScopeGeneration=0',
    ), 0);
    assert.equal(scopedCurrentUserRequestGeneration(
      'GET', `/api/auth/user?proprDesktopScopeGeneration=${Number.MAX_SAFE_INTEGER}`,
    ), Number.MAX_SAFE_INTEGER);
  });

  it('rejects hosted, non-GET, duplicate, unrelated, and unbounded query forms', () => {
    for (const [method, url] of [
      ['GET', '/api/auth/user'],
      ['POST', '/api/auth/user?proprDesktopScopeGeneration=1'],
      ['GET', '/api/auth/user?proprDesktopScopeGeneration=1&proprDesktopScopeGeneration=2'],
      ['GET', '/api/auth/user?proprDesktopScopeGeneration=1&credential=secret'],
      ['GET', '/api/auth/user?proprDesktopScopeGeneration=01'],
      ['GET', '/api/auth/user?proprDesktopScopeGeneration=9007199254740992'],
      ['GET', '/api/smoke/rest?proprDesktopScopeGeneration=1'],
    ]) {
      assert.equal(scopedCurrentUserRequestGeneration(method, url), null, `${method} ${url}`);
    }
  });
});

describe('packaged current-user fixture request shapes', () => {
  it('distinguishes the exact main probe from renderer-scoped validation', () => {
    assert.deepEqual(classifyCurrentUserRequestShape(
      'GET', '/api/auth/user', undefined,
    ), { source: 'main', scopeGeneration: null });
    assert.deepEqual(classifyCurrentUserRequestShape(
      'GET', '/api/auth/user', 'https://non-renderer.example.test',
    ), { source: 'main', scopeGeneration: null });
    assert.deepEqual(classifyCurrentUserRequestShape(
      'GET', '/api/auth/user?proprDesktopScopeGeneration=7', 'propr-app://renderer',
    ), { source: 'renderer', scopeGeneration: 7 });
  });

  it('rejects cross-assigned, duplicate, extra, and noncanonical encoded forms', () => {
    for (const [method, url, origin] of [
      ['GET', '/api/auth/user?proprDesktopScopeGeneration=7', undefined],
      ['GET', '/api/auth/user', 'propr-app://renderer'],
      ['GET', '/api/auth/user?proprDesktopScopeGeneration=7&proprDesktopScopeGeneration=8', 'propr-app://renderer'],
      ['GET', '/api/auth/user?proprDesktopScopeGeneration=7&extra=1', 'propr-app://renderer'],
      ['GET', '/api/auth/user?%70roprDesktopScopeGeneration=7', 'propr-app://renderer'],
      ['GET', '/api/auth/user?proprDesktopScopeGeneration=%37', 'propr-app://renderer'],
      ['GET', '/api/auth/user?proprDesktopScopeGeneration=07', 'propr-app://renderer'],
      ['GET', '/api/auth/user?', undefined],
      ['POST', '/api/auth/user', undefined],
    ]) {
      assert.equal(classifyCurrentUserRequestShape(method, url, origin), null, `${method} ${url}`);
    }
  });
});

describe('packaged current-user acceptance correlation', () => {
  it('diagnoses a correlated zero-scope record', () => {
    assert.equal(classify({
      ...acceptedMain, scopeHeaderCount: 0, accepted: false, rejectionCategory: 'scope-missing',
      outboundBearerPresent: false, bearerMainInjected: false,
    }), 'current-user-main-scope-missing');
  });

  it('diagnoses a correlated duplicate-scope record', () => {
    assert.equal(classify({
      ...acceptedMain, scopeHeaderCount: 2, accepted: false, rejectionCategory: 'scope-duplicate',
      outboundBearerPresent: false, bearerMainInjected: false,
    }), 'current-user-main-scope-duplicate');
  });

  it('diagnoses a correlated no-binding record', () => {
    assert.equal(classify({
      ...acceptedMain, activeBindingPresent: false, accepted: false, rejectionCategory: 'no-active-binding',
      profileGenerationCurrent: false, scopeEqualsActive: false, originEqualsActive: false,
      outboundBearerPresent: false, bearerMainInjected: false,
    }), 'current-user-main-no-active-binding');
  });

  it('diagnoses a correlated stale-scope record', () => {
    assert.equal(classify({
      ...acceptedMain, accepted: false, rejectionCategory: 'stale-scope', scopeEqualsActive: false,
      outboundBearerPresent: false, bearerMainInjected: false,
    }), 'current-user-main-stale-scope');
  });

  it('accepts the current scope with main-only bearer custody', () => {
    assert.equal(classify(acceptedMain), 'none');
  });

  it('rejects a main or upstream record from another renderer generation', () => {
    assert.equal(classify({
      ...acceptedMain, rendererScopeGeneration: 2,
    }), 'current-user-main-generation-correlation-invalid');
    assert.equal(currentUserValidationFailureCategory({
      journey,
      evidenceInvalid: false,
      rendererRecords,
      mainRecords: [acceptedMain],
      fixtureRecords: [{ ...fixtureRecords[0], scopeGeneration: 2 }],
    }), 'current-user-upstream-generation-correlation-invalid');
  });

  it('correlates main evidence by journey and upstream evidence by renderer request origin', () => {
    assert.equal(currentUserValidationFailureCategory({
      journey,
      evidenceInvalid: false,
      rendererRecords,
      mainRecords: [
        { ...acceptedMain, journey: 'another-journey', accepted: false, rejectionCategory: 'stale-scope' },
        acceptedMain,
      ],
      fixtureRecords: [
        { ...fixtureRecords[0], source: 'main', authorizationMatchesActivatedBearer: false },
        fixtureRecords[0],
      ],
    }), 'none');
  });

  it('diagnoses upstream bearer custody after correlating the fixture record', () => {
    assert.equal(currentUserValidationFailureCategory({
      journey,
      evidenceInvalid: false,
      rendererRecords,
      mainRecords: [acceptedMain],
      fixtureRecords: [{ ...fixtureRecords[0], authorizationMatchesActivatedBearer: false }],
    }), 'current-user-upstream-bearer-custody-invalid');
  });
});

describe('packaged current-user strict failure diagnostics', () => {
  it('reports fixed bounded Local Network Access decision counts', () => {
    const base = {
      journey,
      permissionCategory: 'loopback-network',
      decision: 'check',
      allowed: true,
      activeBindingCurrent: true,
      webContentsPresent: false,
      webContentsEqualsMainWindow: false,
      mainWindowPresent: true,
      isMainFrame: true,
      requestingUrlPresent: false,
      requestingUrlTrusted: false,
      rendererDocumentUrlTrusted: true,
      requestingOriginAuthorityValid: true,
      requestingOriginAuthorityEqual: true,
    };
    const summary = networkPermissionDecisionSummary({
      journey,
      records: [
        base,
        {
          ...base,
          permissionCategory: 'local-network-access',
          decision: 'request',
          allowed: false,
          webContentsPresent: true,
          webContentsEqualsMainWindow: true,
          requestingUrlPresent: true,
          requestingUrlTrusted: true,
        },
        ...Array.from({ length: 12 }, () => ({ ...base, journey: 'another-journey' })),
      ],
      invalidCount: 12,
    });

    assert.deepEqual(summary, {
      schemaVersion: 1,
      records: 2,
      check: 1,
      request: 1,
      allowed: 1,
      denied: 1,
      localNetworkAccess: 1,
      localNetwork: 0,
      loopbackNetwork: 1,
      activeBindingCurrent: 2,
      webContentsPresent: 1,
      webContentsEqualsMainWindow: 1,
      mainWindowPresent: 2,
      mainFrame: 2,
      requestingUrlPresent: 1,
      requestingUrlTrusted: 1,
      rendererDocumentUrlTrusted: 2,
      requestingOriginAuthorityValid: 2,
      requestingOriginAuthorityEqual: 2,
      invalid: 9,
    });
    assert.doesNotMatch(JSON.stringify(summary), /example\.test|propr_it_|Bearer|renderer\.html/);
  });

  it('reports fixed bounded phase counts without retaining request secrets', () => {
    const summary = currentUserValidationPhaseSummary({
      journey,
      rendererRecords: [
        { journey, activeScopePresent: true, scopeGeneration: 1, phase: 'request-issued' },
        { journey, activeScopePresent: true, scopeGeneration: 1, phase: 'active-scope-rejected' },
      ],
      mainRecords: [],
      fixtureRecords: [],
      requestRecords: Array.from({ length: 12 }, () => ({
        journey,
        method: 'OPTIONS',
        origin: 'propr-app://renderer',
        url: '/api/auth/user?proprDesktopScopeGeneration=1',
        authorization: 'Bearer must-not-appear',
      })),
    });

    assert.deepEqual(summary, {
      schemaVersion: 1,
      options: 9,
      get: 0,
      main: 0,
      mainAccepted: 0,
      fixture: 0,
      fixture200: 0,
      requestIssued: 1,
      responseCompleted: 0,
      parsedUserAccepted: 0,
      activeScopeAccepted: 0,
      rejected: 1,
    });
    assert.equal(JSON.stringify(summary).includes('must-not-appear'), false);
  });
});
