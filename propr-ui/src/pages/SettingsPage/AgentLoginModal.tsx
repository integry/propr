import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentConfig } from '../../api/proprApi';
import {
  cancelAgentLogin,
  getAgentLogin,
  sendAgentLoginInput,
  startAgentLogin,
  type AgentLoginSession,
} from '../../api/agentLoginApi';
import { ProviderLogo } from '../../components/ui/ProviderLogo';

const POLL_INTERVAL_MS = 750;
const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const ACTIVE_STATUSES = new Set(['starting', 'running']);

interface AgentLoginModalProps {
  agent: AgentConfig;
  onClose: () => void;
}

function isActive(session?: AgentLoginSession): boolean {
  return Boolean(session && ACTIVE_STATUSES.has(session.status));
}

function statusLabel(session?: AgentLoginSession): string {
  switch (session?.status) {
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Waiting for login';
    case 'succeeded':
      return 'Authenticated';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'timed_out':
      return 'Timed out';
    default:
      return 'Starting';
  }
}

function statusClasses(session?: AgentLoginSession): string {
  switch (session?.status) {
    case 'succeeded':
      return 'border-green-200 bg-green-50 text-green-700';
    case 'failed':
    case 'timed_out':
      return 'border-red-200 bg-red-50 text-red-700';
    case 'cancelled':
      return 'border-gray-200 bg-gray-50 text-gray-600';
    default:
      return 'border-amber-200 bg-amber-50 text-amber-700';
  }
}

function trimUrlPunctuation(value: string): { url: string; suffix: string } {
  const match = value.match(/^(.*?)([),.;]+)?$/);
  return { url: match?.[1] || value, suffix: match?.[2] || '' };
}

function LinkifiedOutput({ output }: { output: string }) {
  const parts = useMemo(() => output.split(URL_RE), [output]);
  return (
    <>
      {parts.map((part, index) => {
        if (!/^https?:\/\//.test(part)) return <React.Fragment key={index}>{part}</React.Fragment>;
        const { url, suffix } = trimUrlPunctuation(part);
        return (
          <React.Fragment key={index}>
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-cyan-300 underline decoration-cyan-500 underline-offset-2 hover:text-cyan-200"
            >
              {url}
            </a>
            {suffix}
          </React.Fragment>
        );
      })}
    </>
  );
}

const AgentLoginModal: React.FC<AgentLoginModalProps> = ({ agent, onClose }) => {
  const [session, setSession] = useState<AgentLoginSession>();
  const [input, setInput] = useState('');
  const [requestError, setRequestError] = useState<string>();
  const [sending, setSending] = useState(false);
  const sessionRef = useRef<AgentLoginSession>();
  const startPromiseRef = useRef<Promise<AgentLoginSession>>();
  const cancelTimerRef = useRef<number>();
  const outputRef = useRef<HTMLDivElement>(null);
  const sessionId = session?.id;
  const sessionStatus = session?.status;

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (cancelTimerRef.current !== undefined) {
      window.clearTimeout(cancelTimerRef.current);
      cancelTimerRef.current = undefined;
    }
    let disposed = false;
    startPromiseRef.current ??= startAgentLogin(agent.id);
    void startPromiseRef.current
      .then(next => {
        sessionRef.current = next;
        if (!disposed) {
          setSession(next);
          setRequestError(undefined);
        }
      })
      .catch(error => {
        if (!disposed) setRequestError((error as Error).message || 'Could not start agent login');
      });
    return () => {
      disposed = true;
      // React StrictMode immediately re-runs effects in development. Deferring
      // cancellation lets that second setup clear this timer, while a real
      // dialog unmount still cleans up the remote session.
      cancelTimerRef.current = window.setTimeout(() => {
        void startPromiseRef.current
          ?.then(current => {
            sessionRef.current = current;
            return isActive(current)
              ? cancelAgentLogin(agent.id, current.id)
              : undefined;
          })
          .catch(() => undefined);
      }, 0);
    };
  }, [agent.id]);

  useEffect(() => {
    if (!sessionId || !sessionStatus || !ACTIVE_STATUSES.has(sessionStatus)) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      let keepPolling = true;
      try {
        const next = await getAgentLogin(agent.id, sessionId);
        if (!disposed) {
          setSession(next);
          setRequestError(undefined);
          keepPolling = isActive(next);
        }
      } catch (error) {
        if (!disposed) {
          setRequestError((error as Error).message || 'Could not refresh login status');
        }
      }
      if (!disposed && keepPolling) {
        timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };
    timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [agent.id, sessionId, sessionStatus]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [session?.output]);

  const sendTerminalInput = async (value: string, clearTextInput = false) => {
    if (!session || session.status !== 'running') return;
    setSending(true);
    setRequestError(undefined);
    try {
      const next = await sendAgentLoginInput(agent.id, session.id, value);
      setSession(next);
      if (clearTextInput) setInput('');
    } catch (error) {
      setRequestError((error as Error).message || 'Could not send login response');
    } finally {
      setSending(false);
    }
  };

  const submitInput = (event: React.FormEvent) => {
    event.preventDefault();
    void sendTerminalInput(`${input}\n`, true);
  };

  const close = async () => {
    const current = sessionRef.current;
    if (current && isActive(current)) {
      try {
        await cancelAgentLogin(agent.id, current.id);
      } catch {
        // The session may have completed between the last poll and this click.
      }
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-login-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <ProviderLogo provider={agent.type} className="h-6 w-6 flex-shrink-0 text-gray-700" />
            <div className="min-w-0">
              <h2 id="agent-login-title" className="truncate text-lg font-semibold text-gray-900">
                Log in to {agent.alias}
              </h2>
              <p className="truncate text-xs text-gray-500">Credentials are saved to {agent.configPath}</p>
            </div>
          </div>
          <span className={`ml-3 rounded-full border px-2.5 py-1 text-xs font-medium ${statusClasses(session)}`}>
            {statusLabel(session)}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
          <p className="text-sm text-gray-600">
            Follow the agent’s instructions below. Open any authorization link in a new tab, then paste a requested confirmation code or response here.
          </p>

          <div
            ref={outputRef}
            aria-label="Agent login output"
            className="min-h-52 flex-1 overflow-auto rounded-md bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200"
          >
            <pre className="whitespace-pre-wrap break-words font-inherit">
              {session?.output ? <LinkifiedOutput output={session.output} /> : 'Starting login container…'}
            </pre>
          </div>

          {(requestError || session?.error) && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {requestError || session?.error}
            </div>
          )}

          {session?.status === 'succeeded' && (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
              Login completed. New jobs can now use these credentials.
            </div>
          )}

          <form onSubmit={submitInput} className="flex gap-2">
            <label htmlFor="agent-login-input" className="sr-only">Login response or confirmation code</label>
            <input
              id="agent-login-input"
              value={input}
              onChange={event => setInput(event.target.value)}
              disabled={session?.status !== 'running' || sending}
              autoComplete="off"
              spellCheck={false}
              placeholder="Confirmation code, response, or blank for Enter"
              className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 font-mono text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:bg-gray-100"
            />
            <button
              type="submit"
              disabled={session?.status !== 'running' || sending}
              className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </form>

          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>Terminal keys:</span>
            {[
              { label: '↑', value: '\u001b[A', title: 'Up arrow' },
              { label: '↓', value: '\u001b[B', title: 'Down arrow' },
              { label: 'Enter', value: '\n', title: 'Enter' },
            ].map(key => (
              <button
                key={key.title}
                type="button"
                aria-label={key.title}
                onClick={() => void sendTerminalInput(key.value)}
                disabled={session?.status !== 'running' || sending}
                className="rounded border border-gray-300 bg-white px-2 py-1 font-mono text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
              >
                {key.label}
              </button>
            ))}
            <span className="ml-1">Use these for provider and login-method menus.</span>
          </div>
        </div>

        <div className="flex justify-end border-t border-gray-200 px-5 py-3">
          <button
            type="button"
            onClick={() => void close()}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {isActive(session) ? 'Cancel login' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentLoginModal;
