import type { AgentTerminationReason, TaskTerminalReason } from '@propr/core';
import { taskTerminalReasonForAgentTermination as terminalReasonFor } from '@propr/shared';

/** The task terminal reason recorded for an agent run that ended this way, if any. */
export function taskTerminalReasonForAgentTermination(reason: AgentTerminationReason | undefined): TaskTerminalReason | undefined {
  return terminalReasonFor(reason);
}
