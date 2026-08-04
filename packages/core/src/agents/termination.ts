import type { AgentTerminationReason } from './types.js';

interface TerminationInput {
    success?: boolean;
    terminationReason?: AgentTerminationReason;
    timedOut?: boolean;
    subtype?: string | null;
    error?: string | null;
}

const EXECUTION_TIMEOUT_PATTERN = /(?:^|\n)(?:command|agent execution) timed out after \d+ms$/i;
const MAX_TURNS_PATTERN = /(?:error[_ -]max[_ -]turns|max(?:imum)?(?: number of)? (?:turns|steps|iterations)(?: reached| exceeded)?)/i;

export function resolveAgentTerminationReason(input: TerminationInput): AgentTerminationReason | undefined {
    if (input.terminationReason) return input.terminationReason;
    if (input.timedOut) return 'timeout';
    if (input.subtype === 'error_max_turns') return 'max_turns';

    const error = input.error?.trim();
    if (!error) return undefined;
    if (EXECUTION_TIMEOUT_PATTERN.test(error)) return 'timeout';
    if (MAX_TURNS_PATTERN.test(error)) return 'max_turns';
    return undefined;
}

export function isIncompleteAgentExecution(input: TerminationInput): boolean {
    return input.success === false && resolveAgentTerminationReason(input) !== undefined;
}

export function describeAgentTermination(reason: AgentTerminationReason): string {
    return reason === 'timeout'
        ? 'The agent reached the execution time limit before it could confirm that all requested work was complete.'
        : 'The agent reached the maximum turn limit before it could confirm that all requested work was complete.';
}
