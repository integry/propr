import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DeepLinkDelivery, type DeepLinkWindow } from './deep-link-delivery';

describe('desktop deep-link delivery', () => {
  const createWindow = (sent: Array<{ channel: string; value: string }>): DeepLinkWindow => ({
    isDestroyed: () => false,
    webContents: {
      isLoading: () => false,
      send: (channel, value) => sent.push({ channel, value }),
    },
  });

  it('queues links received after did-finish-load until the ready window is registered', () => {
    const sent: Array<{ channel: string; value: string }> = [];
    const window = createWindow(sent);
    const delivery = new DeepLinkDelivery<DeepLinkWindow>('desktop:deep-link', ['propr://open?task=initial']);

    delivery.didFinishLoad(window);
    delivery.deliver('propr://open?task=between');

    assert.deepEqual(sent, []);

    delivery.setWindow(window);

    assert.deepEqual(sent, [
      { channel: 'desktop:deep-link', value: 'propr://open?task=initial' },
      { channel: 'desktop:deep-link', value: 'propr://open?task=between' },
    ]);
  });

  it('delivers a queued initial Connect URL before packaged smoke asserts it and only once', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const preloadReady = main.indexOf("throw new Error('Desktop preload bridge was not exposed to the renderer')");
    const readyWindowRegistration = main.indexOf('deepLinkDelivery.setWindow(window);');
    const packagedSmokeStart = main.indexOf('const smokeProfileApiUrl =');
    assert.ok(preloadReady < readyWindowRegistration);
    assert.ok(readyWindowRegistration < packagedSmokeStart);
    assert.equal(main.match(/deepLinkDelivery\.setWindow\(/g)?.length, 1);

    const sent: Array<{ channel: string; value: string }> = [];
    const window = createWindow(sent);
    const connectUrl = 'propr://connect?api=https%3A%2F%2Fconnect.propr.dev';
    const delivery = new DeepLinkDelivery<DeepLinkWindow>('desktop:deep-link', [connectUrl]);

    delivery.didFinishLoad(window);
    assert.deepEqual(sent, []);

    delivery.setWindow(window);
    const assertPackagedSmokeDeepLink = () => {
      assert.deepEqual(sent.filter(({ value }) => value === connectUrl), [
        { channel: 'desktop:deep-link', value: connectUrl },
      ]);
    };
    assertPackagedSmokeDeepLink();

    delivery.didFinishLoad(window);
    delivery.setWindow(window);

    assert.equal(sent.filter(({ value }) => value === connectUrl).length, 1);
  });
});
