import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  currentUserValidationFailureCategory,
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
