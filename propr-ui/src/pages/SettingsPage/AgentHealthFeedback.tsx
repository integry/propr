import { LogIn } from 'lucide-react';
import { isAgentLoginSupported } from '@propr/shared';
import type { AgentConfig } from '../../api/proprApi';
import type { AgentHealthState } from './useAgentHealth';

export default function AgentHealthFeedback({ agent, health, onLogin, onRecheck, readOnly }: {
  agent: AgentConfig;
  health: AgentHealthState;
  onLogin: () => void;
  onRecheck?: () => void;
  readOnly: boolean;
}) {
  return (
    <div className={`mt-2 rounded-md px-3 py-2 text-xs ${health.status === 'error' ? 'border border-red-200 bg-red-50 text-red-800' : 'text-slate-500'}`}>
      {health.status === 'checking' && <p role="status">Checking agent…</p>}
      {health.status === 'ready' && <p role="status" title={`Checked with ${health.model}`}>Ready</p>}
      {health.status === 'error' && (
        <>
          <div role="alert" className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            <p className="font-medium">Agent unavailable</p>
            <p className="mt-1">{health.error || 'Agent check failed.'}</p>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {isAgentLoginSupported(agent.type) && (
              <button type="button" onClick={onLogin} disabled={readOnly} className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 font-medium text-white hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-300">
                <LogIn className="h-3.5 w-3.5" aria-hidden="true" />Log in
              </button>
            )}
            {onRecheck && <button type="button" onClick={onRecheck} disabled={readOnly} className="min-h-9 rounded-md border border-red-200 bg-white px-3 py-1.5 font-medium hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed">Check again</button>}
          </div>
        </>
      )}
    </div>
  );
}
