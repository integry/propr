import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeepLinkDelivery, type DeepLinkWindow } from './deep-link-delivery';

describe('desktop deep-link delivery', () => {
  it('delivers a link received after did-finish-load but before global window assignment', () => {
    const sent: Array<{ channel: string; value: string }> = [];
    const window: DeepLinkWindow = {
      isDestroyed: () => false,
      webContents: {
        isLoading: () => false,
        send: (channel, value) => sent.push({ channel, value }),
      },
    };
    const delivery = new DeepLinkDelivery<DeepLinkWindow>('desktop:deep-link', ['propr://open?task=initial']);

    delivery.didFinishLoad(window);
    delivery.deliver('propr://open?task=between');
    delivery.setWindow(window);

    assert.deepEqual(sent, [
      { channel: 'desktop:deep-link', value: 'propr://open?task=initial' },
      { channel: 'desktop:deep-link', value: 'propr://open?task=between' },
    ]);
  });
});
