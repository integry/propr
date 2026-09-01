import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { waitForUsableElectronRenderer } from './packaged-acceptance-renderer.mjs';

const processFixture = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
const browserFixture = context => Object.assign(new EventEmitter(), {
  contexts: () => [context],
  isConnected: () => true,
});

describe('packaged acceptance renderer discovery', () => {
  it('waits deterministically when CDP precedes the first Electron renderer page', async () => {
    const pages = [];
    const context = { pages: () => pages };
    const child = processFixture();
    const browser = browserFixture(context);
    let polls = 0;
    const page = {
      evaluate: async () => ({ rendererTargetUsable: true }),
      isClosed: () => false,
      url: () => 'propr-app://renderer/index.html',
    };

    const renderer = await waitForUsableElectronRenderer(browser, child, {
      expectedUrlPrefix: 'propr-app://renderer',
      timeoutMs: 1_000,
      sleep: async () => {
        polls += 1;
        pages.push(page);
      },
    });

    assert.equal(polls, 1);
    assert.deepEqual(renderer, { context, page });
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(browser.listenerCount('disconnected'), 0);
  });

  it('rejects process exit while waiting and removes its listeners', async () => {
    const context = { pages: () => [] };
    const child = processFixture();
    const browser = browserFixture(context);
    await assert.rejects(waitForUsableElectronRenderer(browser, child, {
      expectedUrlPrefix: 'propr-app://renderer',
      timeoutMs: 1_000,
      sleep: async () => child.emit('close', 17, null),
    }), /exited.*17/);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(browser.listenerCount('disconnected'), 0);
  });

  it('rejects a strictly bounded timeout when no renderer target appears', async () => {
    const context = { pages: () => [] };
    const child = processFixture();
    const browser = browserFixture(context);
    await assert.rejects(waitForUsableElectronRenderer(browser, child, {
      expectedUrlPrefix: 'propr-app://renderer',
      timeoutMs: 1,
      sleep: async () => new Promise(() => undefined),
    }), /within 1ms/);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(browser.listenerCount('disconnected'), 0);
  });
});
