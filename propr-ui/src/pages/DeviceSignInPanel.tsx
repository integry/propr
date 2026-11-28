import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelDeviceSignIn,
  DeviceSignInRequestError,
  pollDeviceSignIn,
  startDeviceSignIn,
  type DeviceSignInStart,
} from '../api/deviceSignInApi';
import { formatTimeOfDay } from '../utils/dateFormat';

const MIN_POLL_DELAY_MS = 1_000;
const COPIED_RESET_MS = 2_000;

export const GitHubMark: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
  </svg>
);

type PanelState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'code'; start: DeviceSignInStart }
  | { kind: 'completing' }
  | { kind: 'error'; message: string };

interface DeviceSignInPanelProps {
  /** Called once the API has created the session. */
  onSignedIn: () => void | Promise<void>;
}

const primaryButton = 'w-full bg-gray-900 hover:bg-gray-800 disabled:bg-gray-500 text-white font-medium py-3 px-4 rounded-md transition-colors flex items-center justify-center gap-2 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white dark:disabled:bg-gray-400';

/**
 * GitHub device flow sign-in: the API asks GitHub for a code, the person
 * enters it at github.com/login/device, and this panel polls the API until
 * GitHub answers. The code is shown only in the browser that asked for it.
 */
const DeviceSignInPanel: React.FC<DeviceSignInPanelProps> = ({ onSignedIn }) => {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);
  const pollTimer = useRef<number | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const generation = useRef(0);

  const clearPoll = useCallback(() => {
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  useEffect(() => () => {
    generation.current += 1;
    clearPoll();
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, [clearPoll]);

  const schedulePoll = useCallback((start: DeviceSignInStart, delayMs: number) => {
    const current = generation.current;
    clearPoll();
    pollTimer.current = window.setTimeout(async () => {
      if (generation.current !== current) return;
      let result;
      try {
        result = await pollDeviceSignIn(start.attempt);
      } catch {
        // Network blip: keep waiting at GitHub's interval.
        if (generation.current === current) schedulePoll(start, start.interval * 1000);
        return;
      }
      if (generation.current !== current) return;
      if (result.status === 'pending') {
        schedulePoll(start, Math.max(MIN_POLL_DELAY_MS, result.retryAfterMs));
        return;
      }
      if (result.status === 'failed') {
        setState({ kind: 'error', message: result.message });
        return;
      }
      setState({ kind: 'completing' });
      try {
        await onSignedIn();
      } catch {
        setState({ kind: 'error', message: 'Signed in, but the dashboard could not load your session. Reload the page.' });
      }
    }, Math.max(MIN_POLL_DELAY_MS, delayMs));
  }, [clearPoll, onSignedIn]);

  const begin = useCallback(async () => {
    generation.current += 1;
    clearPoll();
    setCopied(false);
    setState({ kind: 'starting' });
    const current = generation.current;
    try {
      const start = await startDeviceSignIn();
      if (generation.current !== current) return;
      setState({ kind: 'code', start });
      schedulePoll(start, start.interval * 1000);
    } catch (error) {
      if (generation.current !== current) return;
      setState({
        kind: 'error',
        message: error instanceof DeviceSignInRequestError ? error.message : 'GitHub sign-in could not start. Try again.',
      });
    }
  }, [clearPoll, schedulePoll]);

  const cancel = useCallback(() => {
    generation.current += 1;
    clearPoll();
    setState({ kind: 'idle' });
    void cancelDeviceSignIn();
  }, [clearPoll]);

  const copyCode = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      setCopied(false);
    }
  }, []);

  if (state.kind === 'code') {
    const { start } = state;
    return (
      <div className="text-left" data-testid="device-sign-in">
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
          Enter this code on GitHub to sign in:
        </p>
        <div className="flex items-stretch gap-2 mb-4">
          <output
            aria-label="GitHub sign-in code"
            className="flex-1 select-all rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-center font-mono text-2xl font-semibold tracking-[0.2em] text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-50"
          >
            {start.userCode}
          </output>
          <button
            type="button"
            onClick={() => { void copyCode(start.userCode); }}
            className="rounded-md border border-gray-200 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <a
          href={start.verificationUri}
          target="_blank"
          rel="noopener noreferrer"
          className={primaryButton}
        >
          <GitHubMark />
          Open github.com/login/device
        </a>
        <div role="status" className="mt-4 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600 dark:border-gray-600 dark:border-t-blue-400" aria-hidden="true" />
          Waiting for you to approve the sign-in on GitHub…
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Expires at {formatTimeOfDay(start.expiresAt)}.
          Enter it only if you started this sign-in here.
        </p>
        <button
          type="button"
          onClick={cancel}
          className="mt-4 text-sm text-gray-500 hover:text-gray-700 hover:underline dark:text-gray-400 dark:hover:text-gray-200"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (state.kind === 'completing') {
    return (
      <div role="status" className="flex items-center justify-center gap-2 py-3 text-sm text-gray-600 dark:text-gray-300">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" aria-hidden="true" />
        Signed in. Opening the dashboard…
      </div>
    );
  }

  return (
    <>
      {state.kind === 'error' && (
        <div role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
          {state.message}
        </div>
      )}
      <button
        type="button"
        data-sign-in="device"
        onClick={() => { void begin(); }}
        disabled={state.kind === 'starting'}
        className={primaryButton}
      >
        <GitHubMark />
        {state.kind === 'starting' ? 'Requesting a code…' : state.kind === 'error' ? 'Try again' : 'Sign in with GitHub'}
      </button>
    </>
  );
};

export default DeviceSignInPanel;
