import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { exercisePackagedCspReload } from './packaged-acceptance-csp-reload.mjs';

const origin = 'http://127.0.0.2:41731';
const fixture = ({ activationReloads = 1, selectionReloads = 0, restartReloads = 0,
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
      send: async method => { assert.equal(method, 'Page.enable'); },
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
        const phase = phases.at(-1);
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
    selected = true;
    page.installPolicy();
    for (let i = 0; i < activationReloads; i++) await page.reload();
    if (routeChanges) page.navigateRoute();
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
  assert.deepEqual(f.phases, ['restart', 'saved-selection', 'removal']);
  assert.equal(f.results[0].removalNarrowed, true);
  assert.equal(f.results[0].restartReloads, 0);
  assert.equal(f.results[0].savedSelectionReloads, 0);
  assert.deepEqual(f.diagnostics, [
    { phase: 'first-activation', policyPresent: true, reloadCount: 1, connected: true },
    { phase: 'restart', policyPresent: true, reloadCount: 0, connected: true },
    { phase: 'saved-selection', policyPresent: true, reloadCount: 0, connected: true },
  ]);
  assert.match(f.results[0].limitation, /fixture/);
});
test('hash routing and subframe navigation do not spend native document reload budgets', async () => {
  const f = fixture({ routeChanges: true, subframeNavigations: true });
  await exercisePackagedCspReload(f);
  assert.equal(f.results[0].firstActivationReloads, 1);
  assert.equal(f.results[0].savedSelectionReloads, 0);
});
test('one startup reload converges without allowing saved selection to reload', async () => {
  const f = fixture({ restartReloads: 1 });
  await exercisePackagedCspReload(f);
  assert.equal(f.results[0].restartReloads, 1);
  assert.equal(f.results[0].restartPolicyPresent, true);
  assert.equal(f.results[0].savedSelectionReloads, 0);
});
test('one delayed startup reload is counted during the convergence window', async () => {
  const f = fixture({ delayedReloadPhase: 'restart' });
  await exercisePackagedCspReload(f);
  assert.equal(f.results[0].restartReloads, 1);
});
for (const [name, options] of [
  ['pinned policy', { pinned: true }], ['missing activation reload', { activationReloads: 0 }],
  ['duplicate activation reload', { activationReloads: 2 }],
  ['chooser reload loop', { selectionReloads: 1 }],
]) test(`native scenario rejects ${name}`, async () => {
  const f = fixture(options);
  await assert.rejects(exercisePackagedCspReload(f), /pinned|exactly one|reload loop/);
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
