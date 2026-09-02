export const CURRENT_USER_SCOPE_GENERATION_QUERY = 'proprDesktopScopeGeneration';

export const scopedCurrentUserRequestGeneration = (method, url) => {
  if (method !== 'GET' || typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url, 'http://fixture.invalid');
  } catch {
    return null;
  }
  if (parsed.pathname !== '/api/auth/user') return null;
  const entries = [...parsed.searchParams];
  if (entries.length !== 1 || entries[0][0] !== CURRENT_USER_SCOPE_GENERATION_QUERY) return null;
  const value = entries[0][1];
  if (!/^(?:0|[1-9]\d{0,15})$/.test(value)
    || parsed.search !== `?${CURRENT_USER_SCOPE_GENERATION_QUERY}=${value}`) return null;
  const generation = Number(value);
  return Number.isSafeInteger(generation) ? generation : null;
};

export const currentUserValidationFailureCategory = ({
  journey,
  evidenceInvalid,
  rendererRecords,
  mainRecords,
  fixtureRecords,
}) => {
  if (evidenceInvalid) return 'current-user-evidence-invalid';
  const renderer = rendererRecords.filter(record => record.journey === journey
    && record.activeScopePresent && record.scopeGeneration > 0);
  const issued = renderer.filter(record => record.phase === 'request-issued');
  if (issued.length === 0) return 'current-user-renderer-request-not-issued';
  if (issued.length !== 1) return 'current-user-renderer-request-duplicate';
  const generation = issued[0].scopeGeneration;

  // Correlate the exact journey first. Security predicates below must diagnose
  // the selected request rather than making rejected evidence unobservable.
  const main = mainRecords.filter(record => record.journey === journey);
  if (main.length === 0) return 'current-user-main-proxy-not-observed';
  if (main.length !== 1) return 'current-user-main-proxy-duplicate';
  const observed = main[0];
  if (observed.scopeHeaderCount !== 1) {
    if (observed.scopeHeaderCount === 0 && !observed.accepted
      && observed.rejectionCategory === 'scope-missing') return 'current-user-main-scope-missing';
    if (observed.scopeHeaderCount === 2 && !observed.accepted
      && observed.rejectionCategory === 'scope-duplicate') return 'current-user-main-scope-duplicate';
    return 'current-user-main-scope-header-count-invalid';
  }
  if (!observed.activeBindingPresent) {
    return !observed.accepted && observed.rejectionCategory === 'no-active-binding'
      ? 'current-user-main-no-active-binding'
      : 'current-user-main-active-binding-missing';
  }
  if (!Number.isSafeInteger(observed.activeScopeGeneration) || observed.activeScopeGeneration < 0) {
    return 'current-user-main-active-generation-invalid';
  }
  if (!observed.accepted) return `current-user-main-${observed.rejectionCategory}`;
  if (observed.rejectionCategory !== 'none') return 'current-user-main-rejection-category-invalid';
  if (!observed.profileGenerationCurrent || !observed.scopeEqualsActive || !observed.originEqualsActive) {
    return 'current-user-main-active-scope-rejected';
  }
  if (observed.rendererBearerPresent || observed.rendererCookiePresent
    || !observed.outboundBearerPresent || !observed.bearerMainInjected) {
    return 'current-user-main-bearer-custody-invalid';
  }
  // Select the journey's exact renderer-originated upstream observation before
  // asserting bearer custody so a malformed request cannot look unobserved.
  const fixture = fixtureRecords.filter(record => record.journey === journey
    && record.source === 'renderer');
  if (fixture.length === 0) return 'current-user-upstream-request-not-arrived';
  if (fixture.length !== 1) return 'current-user-upstream-request-duplicate';
  if (!fixture[0].authorizationPresent || !fixture[0].authorizationMatchesActivatedBearer
    || fixture[0].cookiePresent) return 'current-user-upstream-bearer-custody-invalid';
  if (fixture[0].responseStatus !== 200) return `current-user-response-http-${fixture[0].responseStatus}`;
  const completed = renderer.filter(record => record.scopeGeneration === generation
    && record.phase === 'response-completed');
  if (completed.length === 0) return 'current-user-renderer-response-not-completed';
  if (completed.length !== 1 || completed[0].responseStatus !== 200
    || completed[0].classification !== 'success') return 'current-user-renderer-response-rejected';
  const parsed = renderer.filter(record => record.scopeGeneration === generation
    && (record.phase === 'parsed-user-accepted' || record.phase === 'parsed-user-rejected'));
  if (parsed.length === 0) return 'current-user-parsed-schema-not-observed';
  if (parsed.length !== 1 || parsed[0].phase !== 'parsed-user-accepted' || !parsed[0].schemaAccepted) {
    return 'current-user-parsed-schema-rejected';
  }
  const accepted = renderer.filter(record => record.scopeGeneration === generation
    && record.phase === 'active-scope-accepted');
  if (accepted.length !== 1) return accepted.length === 0
    ? 'current-user-active-scope-not-accepted'
    : 'current-user-active-scope-accepted-duplicate';
  return 'none';
};
