import type { BrowserWindow } from 'electron';
import { WINDOW_FRAME_STATE_CHANNEL } from './shared/window-frame';

/** Native state also covers WM shortcuts, titlebar double-click and tray restore. */
export const synchronizeLinuxWindowFrame = (window: BrowserWindow): void => {
  const contents = window.webContents;
  const publish = (): void => {
    if (window.isDestroyed() || contents.isDestroyed()) return;
    contents.send(WINDOW_FRAME_STATE_CHANNEL, {
      focused: window.isFocused(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    });
  };
  const lifecycle: NodeJS.EventEmitter = window;
  const events = ['focus', 'blur', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore'] as const;
  events.forEach(event => lifecycle.on(event, publish));
  // Replay after every reload, once the sandboxed preload has subscribed.
  contents.on('did-finish-load', publish);
  window.once('closed', () => {
    events.forEach(event => lifecycle.removeListener(event, publish));
    contents.removeListener('did-finish-load', publish);
  });
};
