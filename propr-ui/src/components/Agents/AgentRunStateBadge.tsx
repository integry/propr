import React from 'react';
import type { AutomationRunState } from '@propr/shared';
import { CheckCircle2 } from 'lucide-react';
import { RUN_STATE_BADGE_CLASSES, RUN_STATE_LABELS } from './agentPresentation';

interface AgentRunStateBadgeProps {
  state: AutomationRunState;
  /**
   * Calls a run awaiting approval "Needs review", so preview-mode work stands
   * out in the Agents list; the run views keep the state's own name.
   */
  attention?: boolean;
  className?: string;
  'data-testid'?: string;
}

/** A run's state as a colored pill (completed is neutral gray with a checkmark), shared by the Agents list, run history and run detail. */
export const AgentRunStateBadge: React.FC<AgentRunStateBadgeProps> = ({ state, attention = false, className = '', 'data-testid': testId }) => (
  <span
    data-testid={testId}
    data-state={state}
    className={`inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-full border px-2 py-px text-[11px] font-medium ${RUN_STATE_BADGE_CLASSES[state]} ${className}`}
  >
    {state === 'completed' && <CheckCircle2 aria-hidden="true" className="h-3 w-3 flex-none" />}
    {attention && state === 'awaiting_approval' ? 'Needs review' : RUN_STATE_LABELS[state]}
  </span>
);

export default AgentRunStateBadge;
