import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { exercisePackagedCspReload, observeCspReloadRequestFailures, correlateExpectedCspReloadConsoleRecords, sanitizedCspReloadError, sanitizedCspReloadRequestFailure } from './packaged-acceptance-csp-reload.mjs';

const origin = 'http://127.0.0.2:41731';
const fixture = ({ activationReloads = 1, selectionReloads = 0, restartReloads = 0,
  activationPolicyPresent = true, activationConnected = true,
  restartPolicyPresent = true, delayedReloadPhase, disconnectPhase, pinned = false,
  routeChanges = false, subframeNavigations = false } = {}) => {
  const launches = [], closes = [], phases = [], results = [], diagnostics = [];
  let selected = false;
  let retained = false;
  const launch = async existing => {
    const listeners = new Map();
    let content = (existing && restartPolicyPresent) || pinned ? origin : "connect-src 'self'";
    let restored = false;
    let delayed = false;
    const emit = (event, payload) => { for (const listener of listeners.get(event) ?? []) listener(payload); };
    const navigate = () => {
      emit('framenavigated', page.mainFrame());
      emit('Page.frameNavigated', { frame: { id: 'main' } });
    };
    const navigateRoute = () => {
      emit('framenavigated', page.mainFrame());
      emit('Page.navigatedWithinDocument', { frameId: 'main' });
    };
    const session = {
      on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
      off: (event, fn) => listeners.get(event)?.delete(fn),
      send: async method => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        assert.equal(method, 'Page.enable');
      },
      detach: async () => listeners.clear(),
    };
    const page = {
      mainFrame: () => page,
      installPolicy: () => { content = origin; },
      context: () => ({ newCDPSession: async target => { assert.equal(target, page); return session; } }),
      on: session.on, off: session.off,
      navigateRoute,
      navigateSubframe: () => emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main' } }),
      locator: selector => selector.startsWith('meta')
        ? { getAttribute: async () => content }
        : { filter: () => ({ click: async () => { selected = true; if (routeChanges) navigateRoute(); for (let i = 0; i < selectionReloads; i++) navigate(); } }) },
      getByRole: (_role, { name }) => ({ waitFor: async () => {
        if (existing && !restored && name.startsWith('Connected:')) {
          restored = true;
          for (let i = 0; i < restartReloads; i++) navigate();
        }
        if (name.startsWith('Connected:')) assert.equal(selected, true);
        if (name === 'Choose an account') assert.equal(selected, false);
      }, isVisible: async () => selected }),
      waitForTimeout: async () => {
        const phase = phases.at(-1) === 'pairing' ? 'first-activation' : phases.at(-1);
        if (!delayed && delayedReloadPhase === phase) { delayed = true; navigate(); }
        if (disconnectPhase === phase) selected = false;
      },
      evaluate: async fn => runInNewContext(`(${fn.toString()})()`, { window: { proprDesktop: { profiles: {
        setActive: async () => { selected = false; },
        list: async () => ({ activeProfileId: 'profile' }),
        remove: async id => { assert.equal(id, 'profile'); selected = false; content = "connect-src 'self'"; navigate(); },
      } } } }),
      reload: async () => navigate(),
      waitForFunction: async (fn, endpoint) => assert.equal(runInNewContext(`(${fn.toString()})(endpoint)`, {
        endpoint, document: { querySelector: () => ({ getAttribute: () => content }) },
      }), true),
    };
    if (existing) { assert.equal(retained, true); assert.equal(existing, 'owned-profile'); }
    launches.push(existing);
    return { page, userData: 'owned-profile', close: async options => { retained = Boolean(options?.preserveProfile); closes.push(options); } };
  };
  const pair = async page => {
    selected = activationConnected;
    if (activationPolicyPresent) page.installPolicy();
    for (let i = 0; i < activationReloads; i++) await page.reload();
    for (let i = 0; i < Number(routeChanges); i++) page.navigateRoute();
    if (subframeNavigations) page.navigateSubframe();
  };
  return { launch, pair, origin, observe: phase => phases.push(phase), evidence: result => results.push(result),
    diagnostic: record => diagnostics.push(record), launches, closes, phases, results, diagnostics };
};

test('native scenario restarts the same profile, selects through the UI, and reports fixture limits', async () => {
  const f = fixture();
  await exercisePackagedCspReload(f);
  assert.deepEqual(f.launches, [undefined, 'owned-profile']);
  assert.deepEqual(f.closes, [{ preserveProfile: true }, undefined]);
  assert.deepEqual(f.phases, ['startup', 'pairing', 'restart', 'deselection', 'saved-selection', 'removal']);
  assert.equal(f.results[0].removalNarrowed, true);
  assert.equal(f.results[0].restartReloads, 0);
  assert.equal(f.results[0].savedSelectionReloads, 0);
  assert.deepEqual(f.diagnostics, [
    { phase: 'first-activation', policyPresent: true, reloadCount: 1, connected: true, navigationSequence: ['document'] },
    { phase: 'restart', policyPresent: true, reloadCount: 0, connected: true },
    { phase: 'saved-selection', policyPresent: true, reloadCount: 0, connected: true },
  ]);
  assert.match(f.results[0].limitation, /fixture/);
});
test('hash routing and subframe navigation do not spend native document reload budgets', async () => {
  const f = fixture({ routeChanges: true, subframeNavigations: true });
  await exercisePackagedCspReload(f);
  assert.equal(f.results[0].firstActivationReloads, 1);
  assert.deepEqual(f.diagnostics[0].navigationSequence, ['document', 'same-document']);
  assert.equal(f.results[0].savedSelectionReloads, 0);
});
test('one startup reload converges without allowing saved selection to reload', async () => {
  const f = fixture({ restartReloads: 1 });
  await exercisePackagedCspReload(f);
  assert.equal(f.results[0].restartReloads, 1);
  assert.equal(f.results[0].restartPolicyPresent, true);
  assert.equal(f.results[0].savedSelectionReloads, 0);
});
test('activation navigation diagnostics remain bounded during route churn', async () => {
  const f = fixture({ routeChanges: 40 });
  await exercisePackagedCspReload(f);
  assert.equal(f.results[0].firstActivationReloads, 1);
  assert.deepEqual(f.diagnostics[0].navigationSequence, ['document', ...Array(31).fill('same-document')]);
});
test('one delayed startup reload is counted during the convergence window', async () => {
  const f = fixture({ delayedReloadPhase: 'restart' });
  await exercisePackagedCspReload(f);
  assert.equal(f.results[0].restartReloads, 1);
});
test('one delayed first activation reload converges', async () => {
  const f = fixture({ activationReloads: 0, delayedReloadPhase: 'first-activation' });
  await exercisePackagedCspReload(f);
  assert.equal(f.results[0].firstActivationReloads, 1);
  assert.equal(f.results[0].firstActivationPolicyPresent, true);
});
for (const [name, options, count, policyPresent, connected, sequence] of [
  ['no reload', { activationReloads: 0 }, 0, true, true, []],
  ['multiple reloads', { activationReloads: 2 }, 2, true, true, ['document', 'document']],
  ['late reload loop', { delayedReloadPhase: 'first-activation' }, 2, true, true, ['document', 'document']],
  ['missing policy', { activationPolicyPresent: false }, 1, false, true, ['document']],
  ['connection timeout', { activationConnected: false }, 1, true, false, ['document']],
  ['late disconnection', { disconnectPhase: 'first-activation' }, 1, true, false, ['document']],
]) test(`first activation reports sanitized diagnostics for ${name}`, async () => {
  const f = fixture(options);
  await assert.rejects(exercisePackagedCspReload(f));
  assert.deepEqual(f.diagnostics, [{ phase: 'first-activation', policyPresent,
    reloadCount: count, connected, navigationSequence: sequence }]);
  assert.equal(JSON.stringify(f.diagnostics).includes(origin), false);
  assert.equal(f.closes.at(-1), undefined);
  assert.equal(f.results.length, 0);
});
for (const [name, options] of [
  ['pinned policy', { pinned: true }], ['missing activation reload', { activationReloads: 0 }],
  ['duplicate activation reload', { activationReloads: 2 }],
  ['chooser reload loop', { selectionReloads: 1 }],
]) test(`native scenario rejects ${name}`, async () => {
  const f = fixture(options);
  await assert.rejects(exercisePackagedCspReload(f), /pinned|exactly one|single policy reload|reload loop/);
  assert.equal(f.closes.at(-1), undefined);
  assert.equal(f.results.length, 0);
});
for (const [name, options, error, expected] of [
  ['missing restart policy', { restartPolicyPresent: false }, /missing its CSP policy/,
    { phase: 'restart', policyPresent: false, reloadCount: 0, connected: true }],
  ['repeated startup reloads', { restartReloads: 2 }, /single startup policy reload/,
    { phase: 'restart', policyPresent: true, reloadCount: 2, connected: true }],
  ['late startup loop', { restartReloads: 1, delayedReloadPhase: 'restart' }, /single startup policy reload/,
    { phase: 'restart', policyPresent: true, reloadCount: 2, connected: true }],
  ['late selection reload', { delayedReloadPhase: 'saved-selection' }, /reload loop/,
    { phase: 'saved-selection', policyPresent: true, reloadCount: 1, connected: true }],
  ['return to chooser', { disconnectPhase: 'saved-selection' }, /remain Connected/,
    { phase: 'saved-selection', policyPresent: true, reloadCount: 0, connected: false }],
]) test(`native scenario rejects ${name} with bounded diagnostics`, async () => {
  const f = fixture(options);
  await assert.rejects(exercisePackagedCspReload(f), error);
  assert.deepEqual(f.diagnostics.at(-1), expected);
  assert.equal(JSON.stringify(f.diagnostics).includes(origin), false);
  assert.equal(f.closes.at(-1), undefined);
  assert.equal(f.results.length, 0);
});

const transitionErrors = () => ['/api/auth/user?proprDesktopScopeGeneration=1', '/api/auth/demo-mode'].flatMap(path => {
  const url = `${origin}${path}`;
  const policy = { type: 'error', pageId: 1, journey: 'csp-reload-pairing',
    text: `Connecting to '${url}' violates the following Content Security Policy directive: "connect-src 'self' https: wss:". The action has been blocked.` };
  return [policy, { ...policy }, { ...policy,
    text: `Fetch API cannot load ${url}. Refused to connect because it violates the document's Content Security Policy.` }];
});
const deniedRequests = () => ['/api/auth/user?proprDesktopScopeGeneration=1', '/api/auth/demo-mode'].map(path => ({
  scenario: 'csp-reload', pageId: 1, mainFrame: true, journey: 'csp-reload-pairing', failureJourney: 'csp-reload-pairing',
  url: `${origin}${path}`, method: 'GET', resourceType: 'fetch', errorText: 'net::ERR_BLOCKED_BY_CSP',
}));
const convergedEvidence = {
  firstActivationReloads: 1, firstActivationPolicyPresent: true,
  restartReloads: 0, restartPolicyPresent: true, restartConnected: true,
  savedSelectionReloads: 0, savedSelectionPolicyPresent: true, removalNarrowed: true,
};
test('only bounded bootstrap CSP denials in a converged native activation are expected', () => {
  const records = transitionErrors();
  const correlate = (records, evidence = convergedEvidence) =>
    correlateExpectedCspReloadConsoleRecords({ records, origin, evidence, deniedRequests: deniedRequests() });
  assert.deepEqual(correlate(records), records);
  assert.deepEqual(correlate([]), []);
  assert.deepEqual(correlate(records.slice(0, 3)), records.slice(0, 3));
  for (const evidence of [undefined, { ...convergedEvidence, firstActivationReloads: 2 },
    { ...convergedEvidence, firstActivationPolicyPresent: false },
    { ...convergedEvidence, restartPolicyPresent: false },
    { ...convergedEvidence, savedSelectionReloads: 1 },
    { ...convergedEvidence, removalNarrowed: false }]) {
    assert.deepEqual(correlateExpectedCspReloadConsoleRecords({ records, origin, evidence, deniedRequests: deniedRequests() }), []);
  }
  assert.deepEqual(correlate([...records, records[0]]), []);
  assert.deepEqual(correlate([...records, records[2]]), []);
  assert.deepEqual(correlate([...records, { ...records[0], text: records[0].text.replace('Generation=1', 'Generation=2') }]), []);
  for (const transform of [
    record => ({ ...record, pageId: 2 }),
    record => ({ ...record, pageId: undefined }),
    record => ({ ...record, journey: 'csp-reload-restart' }),
    record => ({ ...record, journey: 'csp-reload-saved-selection' }),
    record => ({ ...record, journey: 'dashboard-profile-manager' }),
    record => ({ ...record, text: record.text.replace(origin, 'http://127.0.0.3:41731') }),
    record => ({ ...record, text: record.text.replace('/api/auth/user?proprDesktopScopeGeneration=1', '/api/tasks').replace('/api/auth/demo-mode', '/api/tasks') }),
    record => ({ ...record, text: record.text + ' extra' }),
  ]) assert.deepEqual(correlate(records.map(transform)), []);
  const unrelated = { ...records[0], text: 'Unexpected renderer error' };
  assert.deepEqual(correlate([...records, unrelated]), records);
});

test('runner totals expected transition denials while retaining unrelated console and page failures', () => {
  const source = readFileSync(new URL('./run-packaged-acceptance.mjs', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('const boundedAcceptanceDiagnosticCount ='),
    source.indexOf('const rendererLifecycleDiagnosticSummary ='));
  const records = transitionErrors();
  const summarize = (records, pageErrors = [], evidence = convergedEvidence) => runInNewContext(
    `${functions}; rendererErrorAcceptanceSummary()`, {
      consoleRecords: records, pageErrorRecords: pageErrors,
      cspReloadEvidence: evidence, readyOrigin: origin, cspDeniedRequests: deniedRequests(),
      correlateExpectedCspReloadConsoleRecords,
      correlateExpectedRevokedAuthorizationConsoleRecord: () => undefined,
      fixtureCurrentUserRecords: [], rendererCurrentUserRecords: [],
      FIXED_ACCEPTANCE_ORIGINS: { revoked: 'http://127.0.0.3:41731' },
    });
  const summary = summarize(records);
  assert.equal(summary.errors, 6);
  assert.equal(summary.expectedErrors, 6);
  assert.equal(summary.unexpectedErrors, 0);
  assert.equal(summary.errorCategoryCounts.expectedCspPolicyTransition, 6);
  const failure = summarize([...records, { type: 'error', journey: 'csp-reload-restart', text: 'Unexpected renderer error' }], [{}]);
  assert.equal(failure.expectedErrors, 6);
  assert.equal(failure.unexpectedErrors, 2);
  assert.equal(failure.errorCategoryCounts.other, 1);
  assert.equal(failure.errorCategoryCounts.pageError, 1);
  assert.equal(summarize([...records, records[0]]).unexpectedErrors, 7);
  assert.equal(summarize(records, [], {}).unexpectedErrors, 6);
});

test('CSP exemptions require an observed denial from the exact owned request and phase', () => {
  const records = transitionErrors();
  const correlate = requests => correlateExpectedCspReloadConsoleRecords({
    records, origin, evidence: convergedEvidence, deniedRequests: requests,
  });
  assert.deepEqual(correlate([]), []);
  assert.deepEqual(correlate([...deniedRequests(), deniedRequests()[0]]), []);
  for (const change of [
    { scenario: 'other' }, { pageId: 2 }, { mainFrame: false }, { journey: 'csp-reload-removal' },
    { failureJourney: 'csp-reload-restart' }, { method: 'POST' },
    { resourceType: 'xhr' }, { errorText: 'net::ERR_FAILED' },
    { url: `${origin}/api/auth/user?proprDesktopScopeGeneration=2` },
  ]) assert.deepEqual(correlate(deniedRequests().map(record => ({ ...record, ...change }))), []);
  const removal = records.map(record => ({ ...record, journey: 'csp-reload-removal' }));
  assert.deepEqual(correlateExpectedCspReloadConsoleRecords({ records: removal, origin,
    evidence: convergedEvidence, deniedRequests: deniedRequests().map(record => ({ ...record,
      journey: 'csp-reload-removal', failureJourney: 'csp-reload-removal' })) }), []);
});

const runnerSource = readFileSync(new URL('./run-packaged-acceptance.mjs', import.meta.url), 'utf8');
const runnerDiagnosticFunctions = runnerSource.slice(runnerSource.indexOf('const boundedAcceptanceDiagnosticCount ='),
  runnerSource.indexOf('const rendererLifecycleDiagnosticSummary ='));
const diagnosticContext = (records = [], pageErrors = []) => ({
  consoleRecords: records, pageErrorRecords: pageErrors, cspReloadEvidence: convergedEvidence,
  readyOrigin: origin, cspDeniedRequests: deniedRequests(), ACCEPTANCE_JOURNEYS: [],
  correlateExpectedCspReloadConsoleRecords, sanitizedCspReloadError, sanitizedCspReloadRequestFailure,
  correlateExpectedRevokedAuthorizationConsoleRecord: () => undefined,
  fixtureCurrentUserRecords: [], rendererCurrentUserRecords: [],
  FIXED_ACCEPTANCE_ORIGINS: { revoked: 'http://127.0.0.3:41731' },
});

test('six removal errors retain classes, exact phases and safe request labels without being expected', () => {
  const records = transitionErrors().map(record => ({ ...record, journey: 'csp-reload-removal',
    arguments: ['secret-token'], location: { url: 'https://private.example/secret' } }));
  const result = runInNewContext(`${runnerDiagnosticFunctions}; sanitizedRendererErrorDiagnostics()`,
    diagnosticContext(records));
  assert.equal(result.unexpectedErrors, 6);
  assert.equal(result.errorRecords.length, 6);
  assert.deepEqual(Array.from(result.errorRecords, record => record.errorClass), [
    'csp-connect-policy', 'csp-connect-policy', 'csp-fetch-denied',
    'csp-connect-policy', 'csp-connect-policy', 'csp-fetch-denied',
  ]);
  assert.deepEqual(Array.from(result.errorRecords, record => record.request), [
    'current-user', 'current-user', 'current-user', 'demo-mode', 'demo-mode', 'demo-mode',
  ]);
  assert.ok(result.errorRecords.every(record => record.phase === 'csp-reload-removal'));
  for (const value of [origin, 'secret-token', 'private.example', 'Generation=1', 'connect-src']) {
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test('diagnostics sanitize unknown errors, phases and different CSP directives', () => {
  const secret = 'sensitive-token-and-arguments';
  const records = [
    { type: 'error', journey: secret, text: `TypeError: ${secret}`, arguments: [secret] },
    { ...transitionErrors()[0], text: transitionErrors()[0].text.replace("https: wss:", secret) },
  ];
  const result = runInNewContext(`${runnerDiagnosticFunctions}; sanitizedRendererErrorDiagnostics()`,
    diagnosticContext(records, [{ journey: secret, name: secret, message: secret, stack: secret }]));
  assert.equal(result.unexpectedErrors, 3);
  assert.equal(result.errorRecords[0].phase, 'other');
  assert.equal(result.errorRecords[0].errorClass, 'type-error');
  assert.equal(result.errorRecords[1].errorClass, 'csp-other-policy');
  assert.equal(result.errorRecords[1].request, 'current-user');
  assert.equal(result.errorRecords[2].errorClass, 'other');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(origin), false);
});

test('post-CSP drain includes captures appended while earlier promises settle', async () => {
  const functions = runnerSource.slice(runnerSource.indexOf('const settlePendingRendererConsoleCaptures ='),
    runnerSource.indexOf('const boundedAcceptanceDiagnosticCount ='));
  let lateCapture = false;
  const pendingConsoleRecords = [];
  pendingConsoleRecords.push(Promise.resolve().then(() => {
    pendingConsoleRecords.push(Promise.resolve().then(() => { lateCapture = true; }));
  }));
  await runInNewContext(`${functions}; settlePendingRendererConsoleCaptures()`, { pendingConsoleRecords });
  assert.equal(lateCapture, true);
});

for (const scenarioFailure of [false, true]) test(`failure diagnostics precede ${scenarioFailure ? 'scenario' : 'gate'} throw`, async () => {
  const files = new Map();
  const emitted = [];
  const context = diagnosticContext();
  const scenario = runnerSource.slice(runnerSource.indexOf('  if (!traceWritten)'), runnerSource.indexOf('  const serious ='));
  const drain = runnerSource.slice(runnerSource.indexOf('const settlePendingRendererConsoleCaptures ='),
    runnerSource.indexOf('const boundedAcceptanceDiagnosticCount ='));
  Object.assign(context, {
    traceWritten: true, pendingConsoleRecords: [], processRecords: [], outputDirectory: 'output',
    FIXED_TIME: 'fixed', join: (...parts) => parts.join('/'), Buffer, digest: () => '0'.repeat(64),
    console: { info: (...values) => emitted.push(values) },
    writeFile: async (path, content) => files.set(path, JSON.parse(content)),
    rendererLifecycleInvalidStates: new Map(), boundaryJourneys: new Set(), surfaces: [],
    launchApplication: () => {}, pair: () => {},
    exercisePackagedCspReload: async () => {
      context.pendingConsoleRecords.push(Promise.resolve().then(() => {
        context.consoleRecords.push(...transitionErrors().map(record => ({ ...record, journey: 'csp-reload-removal' })));
      }));
      if (scenarioFailure) throw new Error('scenario failed');
    },
  });
  await assert.rejects(runInNewContext(`(async () => { ${drain}\n${runnerDiagnosticFunctions}\n${scenario} })()`, context),
    scenarioFailure ? /scenario failed/ : /unexpected renderer errors/);
  assert.equal(files.get('output/sanitized-log.json').records.length, 6);
  assert.equal(files.get('output/sanitized-renderer-errors.json').unexpectedErrors, 6);
  assert.equal(emitted.length, 1);
  assert.equal(JSON.stringify([...files]).includes(origin), false);
});

test('destroyed console argument handles cannot erase errors or change their phase', async () => {
  let listener;
  const consoleRecords = [], pendingConsoleRecords = [];
  const source = runnerSource.slice(runnerSource.indexOf("    page.on('console', message => {"),
    runnerSource.indexOf("    page.on('pageerror',"));
  const context = {
    page: { on: (event, callback) => { assert.equal(event, 'console'); listener = callback; } },
    activeJourney: 'csp-reload-removal', scenario: 'csp-reload', pageId: 1,
    consoleRecords, pendingConsoleRecords,
  };
  runInNewContext(source, context);
  listener({
    type: () => 'error', text: () => transitionErrors()[0].text,
    location: () => ({ url: origin }), args: () => [{ jsonValue: async () => { throw new Error('destroyed'); } }],
  });
  assert.equal(consoleRecords.length, 1);
  context.activeJourney = 'fixture-cleanup';
  await Promise.all(pendingConsoleRecords);
  assert.equal(consoleRecords[0].type, 'error');
  assert.equal(consoleRecords[0].journey, 'csp-reload-removal');
  assert.equal(consoleRecords[0].arguments[0].unserializable, true);
});

const requestObserverFixture = async () => {
  const listeners = new Map();
  const records = [];
  let phase = 'csp-reload-pairing';
  const scripts = [];
  const page = {
    context: () => ({ newCDPSession: async () => ({
      on: (event, callback) => listeners.set(event, callback),
      send: async command => assert.equal(command, 'Audits.enable'),
    }) }),
    on: (event, callback) => listeners.set(event, callback),
    addInitScript: async (...args) => scripts.push(args),
    evaluate: async (...args) => scripts.push(args),
  };
  await observeCspReloadRequestFailures({ page, origin, pageId: 1, journey: () => phase, records });
  const attempt = (url, method = 'GET') => listeners.get('console')({
    type: () => 'debug', text: () => `[propr-acceptance-csp-fetch]${JSON.stringify({ url, method })}`,
  });
  const issue = (url, change = {}) => listeners.get('Audits.issueAdded')({ issue: {
    code: 'ContentSecurityPolicyIssue', details: { contentSecurityPolicyIssueDetails: {
      blockedURL: url, violatedDirective: 'connect-src', isReportOnly: false,
      contentSecurityPolicyViolationType: 'kURLViolation', ...change,
    } },
  } });
  return { records, scripts, attempt, issue, phase: value => { phase = value; } };
};

test('pre-network Audits denials correlate only to unique top-frame GET fetch attempts', async () => {
  const f = await requestObserverFixture();
  assert.equal(f.scripts.length, 2); // Future documents and the existing chooser.
  assert.equal(f.scripts[0][0], f.scripts[1][0]);
  for (const path of ['/api/auth/user?proprDesktopScopeGeneration=1', '/api/auth/demo-mode']) {
    f.attempt(origin + path);
    f.issue(origin + path);
  }
  assert.equal(f.records.length, 2);
  assert.deepEqual(correlateExpectedCspReloadConsoleRecords({ records: transitionErrors(), origin,
    evidence: convergedEvidence, deniedRequests: f.records }), transitionErrors());
});

test('missing, duplicate, wrong-method and cross-phase attempts cannot exempt CSP errors', async () => {
  for (const mode of ['missing', 'duplicate', 'POST', 'cross-phase']) {
    const f = await requestObserverFixture();
    for (const path of ['/api/auth/user?proprDesktopScopeGeneration=1', '/api/auth/demo-mode']) {
      const url = origin + path;
      f.phase('csp-reload-pairing');
      if (mode !== 'missing') f.attempt(url, mode === 'POST' ? 'POST' : 'GET');
      if (mode === 'duplicate') f.attempt(url);
      if (mode === 'cross-phase') f.phase('csp-reload-removal');
      f.issue(url);
    }
    assert.deepEqual(correlateExpectedCspReloadConsoleRecords({ records: transitionErrors(), origin,
      evidence: convergedEvidence, deniedRequests: f.records }), [], mode);
  }
});

test('Audits report-only, unrelated directives, origins and paths never supply denial evidence', async () => {
  const f = await requestObserverFixture();
  const url = origin + '/api/auth/demo-mode';
  f.attempt(url);
  for (const change of [{ isReportOnly: true }, { violatedDirective: 'img-src' },
    { contentSecurityPolicyViolationType: 'kInlineViolation' }]) f.issue(url, change);
  f.issue('http://127.0.0.3:41731/api/auth/demo-mode');
  f.issue(origin + '/api/tasks');
  assert.deepEqual(f.records, []);
});

test('fetch observation delegates unchanged arguments and ignores subframes and unrelated requests', async () => {
  const f = await requestObserverFixture();
  const [install, configuration] = f.scripts[0];
  const calls = [], markers = [];
  const window = { fetch: function (...args) { calls.push({ receiver: this, args }); return 'native-result'; } };
  window.top = window;
  const context = { window, Request, URL, console: { debug: text => markers.push(text) } };
  runInNewContext(`(${install.toString()})(${JSON.stringify(configuration)})`, context);
  const options = { method: 'GET', headers: { Authorization: 'secret-bearer' } };
  const url = origin + '/api/auth/demo-mode';
  assert.equal(window.fetch(url, options), 'native-result');
  assert.equal(calls[0].receiver, window);
  assert.equal(calls[0].args[1], options);
  window.fetch(url, { method: 'POST' });
  window.fetch(origin + '/api/tasks');
  window.fetch('https://unrelated.example/api/auth/demo-mode');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].includes('secret-bearer'), false);
  window.fetch(new URL(url));
  window.fetch(new Request(url));
  assert.equal(markers.length, 3);
  const subframe = { fetch: window.fetch, top: {} };
  const original = subframe.fetch;
  runInNewContext(`(${install.toString()})(${JSON.stringify(configuration)})`, { ...context, window: subframe });
  assert.equal(subframe.fetch, original);
});
