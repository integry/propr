import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reachSetupAction, activateSetupAction } from './packaged-acceptance-setup.mjs';

test('keyboard reachability fails closed on presence without focus, clipping, occlusion, or focus indication', async () => {
  for (const failure of ['unfocused', 'visible', 'focusVisible']) {
    let tabs = 0;
    const page = {
      keyboard: { press: async key => { assert.equal(key, 'Tab'); tabs += 1; } },
      getByRole: () => ({ evaluate: async callback => callback.toString().includes('getBoundingClientRect')
        ? { focused: true, visible: failure !== 'visible', focusVisible: failure !== 'focusVisible' }
        : failure !== 'unfocused' }),
    };
    await assert.rejects(reachSetupAction(page, 'Retry setup'), /not keyboard reachable|clipped or obscured/);
    assert.equal(tabs, failure === 'unfocused' ? 40 : 1);
  }
});

test('keyboard activation checks the bridge response as well as the resulting UI', async () => {
  const keys = [], headings = [];
  let evidence = { phase: 'running', calls: [] };
  const page = {
    keyboard: { press: async key => keys.push(key) },
    getByRole: (role, options) => ({ waitFor: async () => headings.push([role, options.name]) }),
    evaluate: async () => evidence,
  };
  await assert.rejects(activateSetupAction(page, 'local-setup-error', 'retry'), /unexpected bridge response/);
  evidence = { phase: 'running', calls: ['retry'] };
  assert.deepEqual(await activateSetupAction(page, 'local-setup-error', 'retry'), {
    activated: true, outcome: 'Setting up ProPR', bridgeCall: 'retry',
  });
  assert.deepEqual(keys, ['Enter', 'Enter']);
  assert.deepEqual(headings, [['heading', 'Setting up ProPR'], ['heading', 'Setting up ProPR']]);
});
