import type { AgentTerminationReason } from './types.js';
import { RUN_COST_CAP_STOP_PATTERN } from '../budget/runCostCap.js';
import { taskTerminalReasonForAgentTermination as terminalReasonFor } from '@propr/shared';

interface TerminationInput {
    success?: boolean;
    terminationReason?: AgentTerminationReason;
    timedOut?: boolean;
    /** The run was stopped because it reached its spend cap. */
    costCapExceeded?: boolean;
    subtype?: string | null;
    error?: string | null;
}

const EXECUTION_TIMEOUT_PATTERN = /(?:^|\n)(?:command|agent execution) timed out after \d+ms$/i;
const MAX_TURNS_PATTERN = /(?:error[_ -]max[_ -]turns|max(?:imum)?(?: number of)? (?:turns|steps|iterations)(?: reached| exceeded)?)/i;

export function resolveAgentTerminationReason(input: TerminationInput): AgentTerminationReason | undefined {
    if (input.terminationReason) return input.terminationReason;
    if (input.costCapExceeded) return 'cost_cap';
    if (input.timedOut) return 'timeout';
    if (input.subtype === 'error_max_turns') return 'max_turns';

    const error = input.error?.trim();
    if (!error) return undefined;
    if (RUN_COST_CAP_STOP_PATTERN.test(error)) return 'cost_cap';
    if (EXECUTION_TIMEOUT_PATTERN.test(error)) return 'timeout';
    if (MAX_TURNS_PATTERN.test(error)) return 'max_turns';
    return undefined;
}

export function isIncompleteAgentExecution(input: TerminationInput): boolean {
    return input.success === false && resolveAgentTerminationReason(input) !== undefined;
}

export function describeAgentTermination(reason: AgentTerminationReason): string {
    if (reason === 'cost_cap') return 'The run reached its spend cap before the agent could confirm that all requested work was complete.';
    return reason === 'timeout'
        ? 'The agent reached the execution time limit before it could confirm that all requested work was complete.'
        : 'The agent reached the maximum turn limit before it could confirm that all requested work was complete.';
}

/** The task terminal reason recorded for an agent that stopped before finishing, if it has one. */
export function taskTerminalReasonForAgentTermination(reason: AgentTerminationReason | undefined): 'timed_out' | 'cost_cap_exceeded' | undefined {
    return terminalReasonFor(reason);
}
