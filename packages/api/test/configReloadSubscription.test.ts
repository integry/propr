import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONFIG_EVENT_CHANNEL,
  startConfigReloadSubscription,
} from '../services/configReloadSubscription.js';

class FakeSubscriber {
  listener?: (message: string) => void;
  calls: string[] = [];
  errors: unknown[] = [];

  on(_event: 'error', listener: (error: Error) => void): void {
    this.errors.push(listener);
  }

  async connect(): Promise<void> { this.calls.push('connect'); }

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    this.calls.push(`subscribe:${channel}`);
    this.listener = listener;
  }

  async unsubscribe(channel: string): Promise<void> { this.calls.push(`unsubscribe:${channel}`); }

  async quit(): Promise<void> { this.calls.push('quit'); }
}

test('API config subscription serializes the startup reload with settings updates', async () => {
  const subscriber = new FakeSubscriber();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstReload = new Promise<void>(resolve => { releaseFirst = resolve; });
  let reloadCount = 0;
  const subscription = await startConfigReloadSubscription(
    { duplicate: () => subscriber },
    async () => {
      reloadCount += 1;
      const current = reloadCount;
      order.push(`start:${current}`);
      if (current === 1) await firstReload;
      order.push(`finish:${current}`);
    },
  );

  const startupReload = subscription.reload();
  subscriber.listener?.(JSON.stringify({ type: 'config_update', subtype: 'settings_update' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['start:1']);

  releaseFirst?.();
  await startupReload;
  await subscription.close();

  assert.deepEqual(order, ['start:1', 'finish:1', 'start:2', 'finish:2']);
  assert.deepEqual(subscriber.calls, [
    'connect',
    `subscribe:${CONFIG_EVENT_CHANNEL}`,
    `unsubscribe:${CONFIG_EVENT_CHANNEL}`,
    'quit',
  ]);
});

test('API config subscription ignores unrelated and malformed events', async () => {
  const subscriber = new FakeSubscriber();
  let reloads = 0;
  const errors: unknown[] = [];
  const subscription = await startConfigReloadSubscription(
    { duplicate: () => subscriber },
    async () => { reloads += 1; },
    { error: (_message, error) => { errors.push(error); } },
  );

  subscriber.listener?.('{bad json');
  subscriber.listener?.(JSON.stringify({ type: 'config_update', subtype: 'agents_update' }));
  await subscription.close();

  assert.equal(reloads, 0);
  assert.equal(errors.length, 1);
});

test('a failed API settings reload does not block the next notification', async () => {
  const subscriber = new FakeSubscriber();
  let reloads = 0;
  const errors: unknown[] = [];
  const subscription = await startConfigReloadSubscription(
    { duplicate: () => subscriber },
    async () => {
      reloads += 1;
      if (reloads === 1) throw new Error('temporary reload failure');
    },
    { error: (_message, error) => { errors.push(error); } },
  );

  subscriber.listener?.(JSON.stringify({ type: 'config_update', subtype: 'settings_update' }));
  subscriber.listener?.(JSON.stringify({ type: 'config_update', subtype: 'settings_update' }));
  await subscription.close();

  assert.equal(reloads, 2);
  assert.equal(errors.length, 1);
});
