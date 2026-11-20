import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { AgentCliVersionState } from '../../api/proprApi';

interface AgentCliVersionStatusProps {
  state?: AgentCliVersionState;
  /** The pending version of this agent became ready while the page was open. */
  becameReady?: boolean;
}

/**
 * Shows that a changed CLI version is not in effect yet: runs keep the
 * previous version until the worker has prepared the new agent image.
 */
const AgentCliVersionStatus: React.FC<AgentCliVersionStatusProps> = ({ state, becameReady = false }) => {
  if (!state) return null;
  const configured = `CLI ${state.configuredVersion ?? 'unknown'}`;
  const current = state.effectiveVersion
    ? `Runs use CLI ${state.effectiveVersion} until it is ready.`
    : 'Runs cannot start until it is ready.';
  if (state.status === 'ready') {
    if (!becameReady) return null;
    return (
      <p role="status" data-testid="agent-cli-version-status" className="mt-2 flex items-start gap-1.5 text-xs text-emerald-700">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{configured} is now in effect.</span>
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <p role="status" data-testid="agent-cli-version-status" className="mt-2 flex items-start gap-1.5 break-words text-xs text-red-700">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          Preparing the image for {configured} failed{state.error ? `: ${state.error}` : '.'}{' '}
          {state.nextRetryAt ? 'It will be retried automatically. ' : ''}{current}
        </span>
      </p>
    );
  }
  return (
    <p role="status" data-testid="agent-cli-version-status" className="mt-2 flex items-start gap-1.5 text-xs text-amber-800">
      <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
      <span>Preparing the agent image for {configured}; this can take several minutes. {current}</span>
    </p>
  );
};

export default AgentCliVersionStatus;
