import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DeepLinkDelivery,
  deepLinkAcknowledgementTimeoutMs,
  type DeepLinkWindow,
} from './deep-link-delivery';
import type { DesktopDeepLinkDelivery } from './shared/contract';

describe('desktop deep-link delivery', () => {
  const createWindow = (sent: DesktopDeepLinkDelivery[]): DeepLinkWindow => ({
    isDestroyed: () => false,
    webContents: {
      isLoading: () => false,
      mainFrame: { frameToken: 'current-document', processId: 1 },
      send: (_channel, value) => sent.push(value),
    },
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const activateWindow = (delivery: DeepLinkDelivery<DeepLinkWindow>, window: DeepLinkWindow) => {
    delivery.setWindow(window);
    assert.equal(delivery.rendererConsumerReady(window.webContents, window.webContents.mainFrame), true);
  };

  it('keeps the production acknowledgement deadline while bounding a native-smoke allowance', () => {
    assert.equal(deepLinkAcknowledgementTimeoutMs(false), 5_000);
    assert.equal(deepLinkAcknowledgementTimeoutMs(true), 15_000);
  });

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
    activateWindow(delivery, window);

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
    activateWindow(delivery, window);

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
      true,
    );
    const window = createWindow(sent);
    activateWindow(delivery, window);
    delivery.deliver('propr://open?path=%2Ftasks');
    await delivery.whenIdle();
    assert.equal(sent.length, 1);
    assert.match(failure?.message ?? '', /acknowledgement deadline/);
  });

  it('reports a synchronous send failure and settles idle before accepting later work', async () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    const failures: Error[] = [];
    let failNextSend = true;
    const window: DeepLinkWindow = {
      isDestroyed: () => false,
      webContents: {
        isLoading: () => false,
        mainFrame: { frameToken: 'current-document', processId: 1 },
        send: (_channel, value) => {
          if (failNextSend) {
            failNextSend = false;
            throw new Error('window destroyed during send');
          }
          sent.push(value);
        },
      },
    };
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link',
      [],
      undefined,
      error => { failures.push(error); },
    );
    activateWindow(delivery, window);

    assert.equal(delivery.deliver('propr://open?path=%2Ftasks'), true);
    await delivery.whenIdle();
    assert.deepEqual(failures.map(error => error.message), ['window destroyed during send']);

    assert.equal(delivery.deliver('propr://open?path=%2Fplans'), true);
    assert.equal(sent.length, 1);
    assert.equal(delivery.acknowledge(window, {
      ...sent[0],
      consumption: { kind: 'open-queued', target: '/plans' },
    }), true);
    await delivery.whenIdle();
  });

  it('continues with accepted queued links after one acknowledgement timeout', async () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    const consumed: string[] = [];
    const failures: Error[] = [];
    const window = createWindow(sent);
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link',
      [],
      value => { consumed.push(value); },
      error => { failures.push(error); },
      Date.now,
      1_000,
      20,
    );
    activateWindow(delivery, window);

    assert.equal(delivery.deliver('propr://open?path=%2Ftasks'), true);
    assert.equal(delivery.deliver('propr://open?path=%2Fplans'), true);
    while (sent.length < 2) await tick();
    assert.equal(delivery.acknowledge(window, {
      ...sent[1],
      consumption: { kind: 'open-queued', target: '/plans' },
    }), true);
    await delivery.whenIdle();

    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /acknowledgement deadline/);
    assert.deepEqual(consumed, ['propr://open?path=%2Fplans']);
  });

  it('closes admission while draining active and pending acknowledgements during shutdown', async () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    const consumed: string[] = [];
    const failures: Error[] = [];
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link',
      [],
      value => { consumed.push(value); },
      error => { failures.push(error); },
    );
    const window = createWindow(sent);
    activateWindow(delivery, window);
    assert.equal(delivery.deliver('propr://open?path=%2Ftasks'), true);
    assert.equal(delivery.deliver('propr://open?path=%2Fplans'), true);
    assert.equal(sent.length, 1);

    delivery.close();
    assert.equal(delivery.deliver('propr://open?path=%2Finbox'), false);
    assert.equal(delivery.acknowledge(window, {
      ...sent[0],
      consumption: { kind: 'open-queued', target: '/tasks' },
    }), true);
    await tick();
    assert.equal(sent.length, 2);
    assert.equal(delivery.acknowledge(window, {
      ...sent[1],
      consumption: { kind: 'open-queued', target: '/plans' },
    }), true);
    await delivery.whenIdle();

    assert.deepEqual(consumed, [
      'propr://open?path=%2Ftasks',
      'propr://open?path=%2Fplans',
    ]);
    assert.deepEqual(failures, []);
  });

  it('clears renderer state without reading webContents from a destroyed window', () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    const webContents = {
      isLoading: () => false,
      mainFrame: { frameToken: 'destroyed-window-document', processId: 1 },
      send: (_channel: string, value: DesktopDeepLinkDelivery) => sent.push(value),
    };
    let destroyed = false;
    const window: DeepLinkWindow = {
      isDestroyed: () => destroyed,
      get webContents() {
        if (destroyed) throw new Error('Object has been destroyed');
        return webContents;
      },
    };
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link', [], undefined, undefined, Date.now, 1_000, 20, true,
    );

    activateWindow(delivery, window);
    delivery.didStartMainFrameNavigation(window);
    destroyed = true;

    assert.doesNotThrow(() => delivery.clearWindow(window));

    const replacement: DeepLinkWindow = {
      isDestroyed: () => false,
      webContents,
    };
    delivery.setWindow(replacement);
    assert.equal(delivery.rendererConsumerReady(webContents, webContents.mainFrame), true);
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
    assert.equal(delivery.hasPendingConnectIntent(), true, 'intent precedes window readiness');
    assert.equal(delivery.deliver(link), false);
    activateWindow(delivery, window);
    assert.equal(sent.length, 1);
    assert.equal(delivery.hasPendingConnectIntent(), true, 'in-flight presentation still owns the intent');
    delivery.acknowledge(window, {
      ...sent[0],
      consumption: { kind: 'connect-confirmation', target: 'https://t-native-evidence.propr.dev' },
    });
    await delivery.whenIdle();
    assert.equal(sent.length, 1);
    assert.equal(delivery.hasPendingConnectIntent(), false);
  });

  it('does not treat queued Open links as Connect intent', () => {
    const delivery = new DeepLinkDelivery('desktop:deep-link', ['propr://open?path=%2Ftasks']);
    assert.equal(delivery.hasPendingConnectIntent(), false);
  });

  it('does not spend the acknowledgement budget before the renderer consumer is ready', async () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    const failures: Error[] = [];
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link',
      ['propr://connect?api=http%3A%2F%2Flocalhost%3A44111'],
      undefined,
      error => { failures.push(error); },
      Date.now,
      1_000,
      20,
      true,
    );
    const window = createWindow(sent);
    delivery.setWindow(window);

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(sent.length, 0);
    assert.deepEqual(failures, []);

    assert.equal(delivery.rendererConsumerReady(window.webContents, window.webContents.mainFrame), true);
    assert.equal(sent.length, 1);
    const dispatched = sent[0];
    assert.ok(dispatched);
    assert.equal(delivery.acknowledge(window, {
      ...dispatched,
      consumption: { kind: 'connect-confirmation', target: 'http://localhost:44111' },
    }), true);
    await delivery.whenIdle();
    assert.deepEqual(failures, []);
  });

  it('fences navigation by document token when Electron reuses its main-frame wrapper', async () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    const mainFrame = { frameToken: 'outgoing-document', processId: 1 };
    const outgoingFrameAfterCommit = { frameToken: 'outgoing-document', processId: 1 };
    const window: DeepLinkWindow = {
      isDestroyed: () => false,
      webContents: {
        isLoading: () => false,
        mainFrame,
        send: (_channel, value) => sent.push(value),
      },
    };
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link', [], undefined, undefined, Date.now, 1_000, 20, true,
    );
    activateWindow(delivery, window);
    delivery.didStartMainFrameNavigation(window);
    delivery.deliver('propr://open?path=%2Ftasks');

    assert.equal(delivery.rendererConsumerReady(window.webContents, mainFrame), false);
    mainFrame.frameToken = 'incoming-document';
    delivery.didCommitMainFrameNavigation(window);
    delivery.didFinishLoad(window);
    assert.equal(sent.length, 0);

    assert.equal(window.webContents.mainFrame, mainFrame);
    assert.equal(delivery.rendererConsumerReady(window.webContents, outgoingFrameAfterCommit), false);
    assert.equal(delivery.rendererConsumerReady(window.webContents, mainFrame), true);
    assert.equal(sent.length, 1);
    const dispatched = sent[0];
    assert.ok(dispatched);
    assert.equal(delivery.acknowledge(window, {
      ...dispatched,
      consumption: { kind: 'open-queued', target: '/tasks' },
    }), true);
    await delivery.whenIdle();
  });

  it('requires fresh readiness after a committed navigation reuses the render-frame identity', async () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    const mainFrame = { frameToken: 'reused-render-frame', processId: 1 };
    const window: DeepLinkWindow = {
      isDestroyed: () => false,
      webContents: {
        isLoading: () => false,
        mainFrame,
        send: (_channel, value) => sent.push(value),
      },
    };
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link',
      ['propr://connect?api=http%3A%2F%2Flocalhost%3A44111'],
      undefined,
      undefined,
      Date.now,
      1_000,
      20,
      true,
    );

    delivery.setWindow(window);
    assert.equal(delivery.rendererConsumerReady(window.webContents, mainFrame), true);
    assert.equal(sent.length, 1);
    assert.equal(delivery.acknowledge(window, {
      ...sent[0],
      consumption: { kind: 'connect-confirmation', target: 'http://localhost:44111' },
    }), true);
    await delivery.whenIdle();

    delivery.didStartMainFrameNavigation(window);
    delivery.deliver('propr://open?path=%2Ftasks');
    assert.equal(delivery.rendererConsumerReady(window.webContents, mainFrame), false);
    delivery.didCommitMainFrameNavigation(window);
    delivery.didFinishLoad(window);
    assert.equal(sent.length, 1, 'outgoing readiness must not survive the commit');

    assert.equal(delivery.rendererConsumerReady(window.webContents, mainFrame), true);
    assert.equal(sent.length, 2);
    assert.equal(delivery.acknowledge(window, {
      ...sent[1],
      consumption: { kind: 'open-queued', target: '/tasks' },
    }), true);
    await delivery.whenIdle();
  });

  it('accepts initial readiness after commit when Electron reuses the initial frame identity', async () => {
    const sent: DesktopDeepLinkDelivery[] = [];
    const mainFrame = { frameToken: 'initial-and-renderer-document', processId: 1 };
    const window: DeepLinkWindow = {
      isDestroyed: () => false,
      webContents: {
        isLoading: () => false,
        mainFrame,
        send: (_channel, value) => sent.push(value),
      },
    };
    const delivery = new DeepLinkDelivery<DeepLinkWindow>(
      'desktop:deep-link',
      ['propr://connect?api=http%3A%2F%2Flocalhost%3A44111'],
      undefined,
      undefined,
      Date.now,
      1_000,
      20,
      true,
    );

    delivery.didStartMainFrameNavigation(window);
    delivery.didCommitMainFrameNavigation(window);
    assert.equal(delivery.rendererConsumerReady(window.webContents, mainFrame), true);
    delivery.didFinishLoad(window);
    delivery.setWindow(window);

    assert.equal(sent.length, 1);
    assert.equal(delivery.acknowledge(window, {
      ...sent[0],
      consumption: { kind: 'connect-confirmation', target: 'http://localhost:44111' },
    }), true);
    await delivery.whenIdle();
  });
});
