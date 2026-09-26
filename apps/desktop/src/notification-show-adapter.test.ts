import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Notification } from 'electron';
import { showElectronNotification } from './notification-show-adapter';

class FakeNotification extends EventEmitter {
  readonly calls: string[] = [];
  closed = false;

  override once(event: string, listener: (...args: unknown[]) => void): this {
    this.calls.push(`listen:${event}`);
    return super.once(event, listener);
  }

  show(): void {
    this.calls.push('show');
  }

  close(): void {
    this.closed = true;
  }
}

test('observes native delivery events before show and discards native failure details', () => {
  const notification = new FakeNotification();
  const received: string[] = [];
  const handle = showElectronNotification(notification as unknown as Notification, {
    click: () => received.push('click'),
    close: () => received.push('close'),
    failed: () => received.push('failed'),
    shown: () => received.push('shown'),
  });

  assert.deepEqual(notification.calls, [
    'listen:click', 'listen:close', 'listen:failed', 'listen:show', 'show',
  ]);
  notification.emit('failed', {}, '/Users/example/private native failure');
  assert.deepEqual(received, ['failed']);

  handle.close();
  assert.equal(notification.closed, true);
});
