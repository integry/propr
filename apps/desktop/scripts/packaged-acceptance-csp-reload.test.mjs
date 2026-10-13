import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { exercisePackagedCspReload } from './packaged-acceptance-csp-reload.mjs';

const origin = 'http://127.0.0.2:41731';
const fixture = ({ activationReloads = 1, selectionReloads = 0, pinned = false } = {}) => {
  const launches = [], closes = [], phases = [], results = [];
  let selected = false;
  let retained = false;
  const launch = async existing => {
    const listeners = new Set();
    let content = existing || pinned ? origin : "connect-src 'self'";
    const navigate = () => { for (const listener of listeners) listener(page.mainFrame()); };
    const page = {
      mainFrame: () => page,
      installPolicy: () => { content = origin; },
      on: (_event, fn) => listeners.add(fn), off: (_event, fn) => listeners.delete(fn),
      locator: selector => selector.startsWith('meta')
        ? { getAttribute: async () => content }
        : { filter: () => ({ click: async () => { selected = true; for (let i = 0; i < selectionReloads; i++) navigate(); } }) },
      getByRole: (_role, { name }) => ({ waitFor: async () => {
        if (name.startsWith('Connected:')) assert.equal(selected, true);
        if (name === 'Choose an account') assert.equal(selected, false);
      } }),
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
  };
  return { launch, pair, origin, observe: phase => phases.push(phase), evidence: result => results.push(result), launches, closes, phases, results };
};

test('native scenario restarts the same profile, selects through the UI, and reports fixture limits', async () => {
  const f = fixture();
  await exercisePackagedCspReload(f);
  assert.deepEqual(f.launches, [undefined, 'owned-profile']);
  assert.deepEqual(f.closes, [{ preserveProfile: true }, undefined]);
  assert.deepEqual(f.phases, ['restart', 'saved-selection', 'removal']);
  assert.equal(f.results[0].removalNarrowed, true);
  assert.match(f.results[0].limitation, /fixture/);
});
for (const [name, options] of [
  ['pinned policy', { pinned: true }], ['duplicate activation reload', { activationReloads: 2 }],
  ['chooser reload loop', { selectionReloads: 1 }],
]) test(`native scenario rejects ${name}`, async () => {
  const f = fixture(options);
  await assert.rejects(exercisePackagedCspReload(f), /pinned|exactly one|reload loop/);
  assert.equal(f.closes.at(-1), undefined);
  assert.equal(f.results.length, 0);
});
