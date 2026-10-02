import { useId, useState } from 'react';
import { ChartNoAxesColumn, LogIn } from 'lucide-react';
import { isAgentLoginSupported } from '@propr/shared';
import type { AgentConfig } from '../../api/proprApi';
import type { AgentHealthState } from './useAgentHealth';
import AgentQuotaUsage from './AgentQuotaUsage';

export default function AgentHealthFeedback({ agent, health, onLogin, onRecheck, readOnly }: {
  agent: AgentConfig;
  health: AgentHealthState;
  onLogin: () => void;
  onRecheck?: () => void;
  readOnly: boolean;
}) {
  const [showUsage, setShowUsage] = useState(false);
  const usageId = useId();
  if (health.status !== 'error') return null;
  const rateLimited = health.errorCode === 'rate_limit';
  return (
    <>
      <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
        <div role="alert" className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          <p className="font-medium">Agent unavailable</p>
          <p className="mt-1">{health.error || 'Agent check failed.'}</p>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {rateLimited && (
            <button type="button" onClick={() => setShowUsage(current => !current)} aria-expanded={showUsage} aria-controls={usageId} className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 font-medium text-white hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2">
              <ChartNoAxesColumn className="h-3.5 w-3.5" aria-hidden="true" />View Quota / Usage
            </button>
          )}
          {health.errorCode === 'auth_required' && isAgentLoginSupported(agent.type) && (
            <button type="button" onClick={onLogin} disabled={readOnly} className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 font-medium text-white hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-300">
              <LogIn className="h-3.5 w-3.5" aria-hidden="true" />Log in
            </button>
          )}
          {onRecheck && <button type="button" onClick={onRecheck} disabled={readOnly} className="min-h-9 rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed">Check again</button>}
        </div>
      </div>
      {rateLimited && showUsage && <AgentQuotaUsage agent={agent} id={usageId} />}
    </>
  );
}
