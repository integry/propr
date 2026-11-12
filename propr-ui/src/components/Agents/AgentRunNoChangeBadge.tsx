import React from 'react';
import { AUTOMATION_RUN_NO_CHANGE_LABELS } from '@propr/shared';
import type { AutomationRunRecord } from '../../api/automationDefinitionsApi';
import { runNoChangeReason } from './agentRunPresentation';

interface AgentRunNoChangeBadgeProps {
  run: Pick<AutomationRunRecord, 'noChangeReason' | 'reportNovelty' | 'actingMutations'>;
  className?: string;
}

/**
 * "No change" for a run whose report was empty or the same as last time, or
 * whose acting step changed nothing. The run still completed; the badge only
 * says it produced nothing. Renders nothing for productive or unflagged runs.
 */
export const AgentRunNoChangeBadge: React.FC<AgentRunNoChangeBadgeProps> = ({ run, className = '' }) => {
  const reason = runNoChangeReason(run);
  if (!reason) return null;
  const label = AUTOMATION_RUN_NO_CHANGE_LABELS[reason];
  return (
    <span
      data-testid="agent-run-no-change"
      data-reason={reason}
      title={label}
      aria-label={`No change: ${label}`}
      className={`inline-flex flex-none items-center whitespace-nowrap rounded-full border border-slate-300 bg-slate-100 px-2 py-px text-[11px] font-medium text-slate-600 ${className}`}
    >
      No change
    </span>
  );
};

export default AgentRunNoChangeBadge;
