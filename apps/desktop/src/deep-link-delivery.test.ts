import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeepLinkDelivery, type DeepLinkWindow } from './deep-link-delivery';
import type { DesktopDeepLinkDelivery } from './shared/contract';

describe('desktop deep-link delivery', () => {
  const createWindow = (sent: DesktopDeepLinkDelivery[]): DeepLinkWindow => ({
    isDestroyed: () => false,
    webContents: {
      isLoading: () => false,
      send: (_channel, value) => sent.push(value),
    },
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));

  it('queues across the load boundary and waits for renderer consumption in order', async () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    const consumed: string[] = [];
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link',
      ['propr://connect?api=http%3A%2F%2Flocalhost%3A4000'],
      value => { consumed.push(value); },
    );
    const window = createWindow(sent);
    delivery.deliver('propr://open?path=%2Ftasks');
    delivery.setWindow(window);

    assert.equal(sent.length, 1);
    assert.deepEqual(consumed, []);
    assert.equal(delivery.acknowledge(window, {
      ...sent[0],
      consumption: { kind: 'connect-confirmation', target: 'http://localhost:4000' },
    }), true);
    await tick();
    assert.equal(sent.length, 2);
    assert.deepEqual(consumed, ['propr://connect?api=http%3A%2F%2Flocalhost%3A4000']);
    assert.equal(delivery.acknowledge(window, {
      ...sent[1],
      consumption: { kind: 'open-queued', target: '/tasks' },
    }), true);
    await delivery.whenIdle();

    assert.deepEqual(consumed, [
      'propr://connect?api=http%3A%2F%2Flocalhost%3A4000',
      'propr://open?path=%2Ftasks',
    ]);
  });

  it('rejects duplicate delivery and duplicate or out-of-order acknowledgements', async () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    const consumed: string[] = [];
    let now = 1_000;
    const link = 'propr://open?path=%2Ftasks';
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link',
      [],
      value => { consumed.push(value); },
      error => { throw error; },
      () => now,
      1_000,
    );
    const window = createWindow(sent);
    delivery.setWindow(window);

    assert.equal(delivery.deliver(link), true);
    assert.equal(delivery.deliver(link), false);
    assert.equal(sent.length, 1);
    assert.equal(delivery.acknowledge(window, {
      deliveryId: sent[0].deliveryId + 1,
      url: link,
      consumption: { kind: 'open-queued', target: '/tasks' },
    }), false);
    const acknowledgement = {
      ...sent[0],
      consumption: { kind: 'open-queued' as const, target: '/tasks' },
    };
    assert.equal(delivery.acknowledge(window, acknowledgement), true);
    assert.equal(delivery.acknowledge(window, acknowledgement), false);
    await delivery.whenIdle();
    assert.deepEqual(consumed, [link]);

    now += 1_001;
    assert.equal(delivery.deliver(link), true);
    await tick();
    assert.equal(sent.length, 2);
    assert.equal(delivery.acknowledge(window, {
      ...sent[1],
      consumption: { kind: 'open-queued', target: '/tasks' },
    }), true);
    await delivery.whenIdle();
    assert.deepEqual(consumed, [link, link]);
  });

  it('fails closed when the renderer does not acknowledge consumption', async () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    let failure: Error | undefined;
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link',
      [],
      undefined,
      error => { failure = error; },
      Date.now,
      1_000,
      20,
    );
    delivery.setWindow(createWindow(sent));
    delivery.deliver('propr://open?path=%2Ftasks');
    await delivery.whenIdle();
    assert.equal(sent.length, 1);
    assert.match(failure?.message ?? '', /acknowledgement deadline/);
  });

  it('deduplicates a cold link reported through argv and open-url before delivery', async () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    const link = 'propr://connect?api=https%3A%2F%2Ft-native-evidence.propr.dev';
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link',
      [link],
      undefined,
      undefined,
      () => 10,
    );
    const window = createWindow(sent);
    assert.equal(delivery.deliver(link), false);
    delivery.setWindow(window);
    assert.equal(sent.length, 1);
    delivery.acknowledge(window, {
      ...sent[0],
      consumption: { kind: 'connect-confirmation', target: 'https://t-native-evidence.propr.dev' },
    });
    await delivery.whenIdle();
    assert.equal(sent.length, 1);
  });
});
