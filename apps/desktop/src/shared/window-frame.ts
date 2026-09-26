export const WINDOW_FRAME_STATE_CHANNEL = 'desktop:window-frame-state';

export interface WindowFrameState {
  focused: boolean;
  maximized: boolean;
  fullScreen: boolean;
}

export const isWindowFrameState = (value: unknown): value is WindowFrameState => {
  if (!value || typeof value !== 'object') return false;
  const state = value as WindowFrameState;
  return typeof state.focused === 'boolean'
    && typeof state.maximized === 'boolean'
    && typeof state.fullScreen === 'boolean';
};
