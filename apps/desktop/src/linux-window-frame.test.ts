import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import type { BrowserWindow } from 'electron';
import { synchronizeLinuxWindowFrame } from './linux-window-frame';
import { WINDOW_FRAME_STATE_CHANNEL } from './shared/window-frame';

it('publishes native focus, maximize, fullscreen and restore state, replays on reload and cleans up', () => {
  let focused = false;
  let maximized = false;
  let fullScreen = false;
  let destroyed = false;
  const deliveries: unknown[] = [];
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    send: (channel: string, state: unknown) => {
      assert.equal(channel, WINDOW_FRAME_STATE_CHANNEL);
      deliveries.push(state);
    },
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    isMaximized: () => maximized,
    isFullScreen: () => fullScreen,
  });
  synchronizeLinuxWindowFrame(window as unknown as BrowserWindow);
  const expectState = () => assert.deepEqual(deliveries.at(-1), { focused, maximized, fullScreen });
  contents.emit('did-finish-load');
  expectState();
  focused = true;
  window.emit('focus');
  expectState();
  maximized = true;
  window.emit('maximize');
  expectState();
  focused = false;
  window.emit('blur');
  expectState();
  contents.emit('did-finish-load');
  expectState();
  maximized = false;
  window.emit('unmaximize');
  expectState();
  fullScreen = true;
  window.emit('enter-full-screen');
  expectState();
  fullScreen = false;
  window.emit('leave-full-screen');
  expectState();
  focused = true;
  window.emit('restore');
  expectState();
  assert.equal(deliveries.length, 9);
  destroyed = true;
  window.emit('blur');
  assert.equal(deliveries.length, 9);
  window.emit('closed');
  assert.deepEqual(window.eventNames(), []);
  assert.deepEqual(contents.eventNames(), []);
});
