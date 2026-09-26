import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installWindowFrameStyles } from '../../../apps/desktop/src/preload-window-frame';
import { WINDOW_FRAME_STATE_CHANNEL } from '../../../apps/desktop/src/shared/window-frame';

describe('Linux frame preload styling', () => {
  it('retains the latest native state until the document root exists', () => {
    const ipc = new EventEmitter();
    const doc = document.implementation.createHTMLDocument();
    const root = doc.documentElement;
    doc.removeChild(root);
    const dispose = installWindowFrameStyles(ipc as never, doc);
    ipc.emit(WINDOW_FRAME_STATE_CHANNEL, {}, { focused: false, maximized: false, fullScreen: false });
    ipc.emit(WINDOW_FRAME_STATE_CHANNEL, {}, { focused: true, maximized: true, fullScreen: false });
    doc.appendChild(root);
    doc.dispatchEvent(new Event('DOMContentLoaded'));
    expect(root.dataset.windowFocused).toBe('true');
    expect(root.dataset.windowExpanded).toBe('true');
    dispose();
  });

  it('applies native states before React and ignores malformed messages', () => {
    const ipc = new EventEmitter();
    const doc = document.implementation.createHTMLDocument();
    const dispose = installWindowFrameStyles(ipc as never, doc);
    const publish = (state: unknown) => ipc.emit(WINDOW_FRAME_STATE_CHANNEL, {}, state);
    publish({ focused: true, maximized: false, fullScreen: false });
    expect({ ...doc.documentElement.dataset }).toEqual({
      desktopWindow: 'linux', windowFocused: 'true', windowExpanded: 'false',
    });
    publish({ focused: false, maximized: true, fullScreen: false });
    expect(doc.documentElement.dataset.windowFocused).toBe('false');
    expect(doc.documentElement.dataset.windowExpanded).toBe('true');
    publish({ focused: true, maximized: false, fullScreen: true });
    expect(doc.documentElement.dataset.windowExpanded).toBe('true');
    publish({ focused: true, maximized: false, fullScreen: false });
    publish({ focused: 'false', maximized: true, fullScreen: false });
    publish(null);
    expect(doc.documentElement.dataset.windowFocused).toBe('true');
    expect(doc.documentElement.dataset.windowExpanded).toBe('false');
    dispose();
    expect(ipc.listenerCount(WINDOW_FRAME_STATE_CHANNEL)).toBe(0);
  });
});
