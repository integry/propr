import type { AgentTerminationReason, TaskTerminalReason } from '@propr/core';

/** The task terminal reason recorded for an agent run that ended this way, if any. */
export function taskTerminalReasonForAgentTermination(reason: AgentTerminationReason | undefined): TaskTerminalReason | undefined {
  if (reason === 'timeout') return 'timed_out';
  if (reason === 'stalled' || reason === 'degenerate_output' || reason === 'cost_cap') return reason;
  return undefined;
}
