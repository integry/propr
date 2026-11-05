import type { MessageBoxOptions } from 'electron';
import { isSafeExternalUrl } from './security';

export function createGithubCodePresenter(dependencies: {
  showDialog(options: MessageBoxOptions): Promise<{ response: number }>;
  copy(code: string): void;
  openExternal(url: string): Promise<void>;
  isShuttingDown(): boolean;
}) {
  return async (code: string, url: string, signal: AbortSignal, cancel: (reason?: 'browser-failure') => void): Promise<() => Promise<void>> => {
    const detail = `Enter this one-time code on GitHub: ${code}\nChoose the intended GitHub account before approving. Return to ProPR to confirm your verified account.`;
    signal.throwIfAborted();
    const prompt = new AbortController();
    const promptSignal = AbortSignal.any([signal, prompt.signal]);
    // Start native UI without awaiting a button: approval in any browser must
    // be polled while the initial dialog is still open.
    const waiting = (async () => {
      let browserOpened = false;
      while (!promptSignal.aborted) {
        const result = await dependencies.showDialog({
          type: 'info', title: browserOpened ? 'Waiting for GitHub' : 'Sign in via GitHub',
          message: browserOpened ? 'Finish signing in in your browser' : 'Open GitHub in your browser', detail,
          buttons: browserOpened ? ['Copy code', 'Cancel sign-in'] : ['Open GitHub', 'Copy code', 'Cancel sign-in'],
          defaultId: 0, cancelId: browserOpened ? 1 : 2, signal: promptSignal,
        });
        if (promptSignal.aborted) return;
        if (dependencies.isShuttingDown()) { cancel('browser-failure'); return; }
        if (result.response === (browserOpened ? 0 : 1)) dependencies.copy(code);
        else if (!browserOpened && result.response === 0) {
          if (!isSafeExternalUrl(url)) { cancel('browser-failure'); return; }
          // An OS browser launch can settle late. It must not hold prompt
          // cleanup or cancel an already completed/superseded attempt.
          void dependencies.openExternal(url).catch(() => { if (!promptSignal.aborted) cancel('browser-failure'); });
          browserOpened = true;
        } else { cancel(); return; }
      }
    })().catch(() => { if (!promptSignal.aborted) cancel('browser-failure'); });
    return async () => { prompt.abort(); await waiting; };
  };
}
