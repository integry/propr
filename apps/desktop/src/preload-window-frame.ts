import type { IpcRenderer } from 'electron';
import { isWindowFrameState, WINDOW_FRAME_STATE_CHANNEL, type WindowFrameState } from './shared/window-frame';

/** Styling state only: no new renderer-callable IPC or window authority. */
export const installWindowFrameStyles = (
  ipc: Pick<IpcRenderer, 'on' | 'removeListener'>,
  document: Document,
): (() => void) => {
  let latest: WindowFrameState | undefined;
  const apply = (): void => {
    if (!latest || !document.documentElement) return;
    const root = document.documentElement;
    root.dataset.desktopWindow = 'linux';
    root.dataset.windowFocused = String(latest.focused);
    root.dataset.windowExpanded = String(latest.maximized || latest.fullScreen);
  };
  const listener = (_event: unknown, state: unknown): void => {
    if (!isWindowFrameState(state)) return;
    latest = state;
    apply();
  };
  ipc.on(WINDOW_FRAME_STATE_CHANNEL, listener);
  document.addEventListener('DOMContentLoaded', apply);
  return () => {
    ipc.removeListener(WINDOW_FRAME_STATE_CHANNEL, listener);
    document.removeEventListener('DOMContentLoaded', apply);
  };
};
