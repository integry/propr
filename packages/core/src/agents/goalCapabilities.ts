import type { AgentType } from './types.js';

export interface GoalCapability {
    agentId: string;
    agentAlias: string;
    agentType: AgentType;
    goalCapable: boolean;
    reason?: string;
}

/** Native goal mode is deliberately limited to providers with documented goal/session support. */
export function helpAdvertisesNativeGoal(helpText: string): boolean {
    return /(?:^|\s)\/goal(?:\s|$|[<[])/im.test(helpText)
        || /native\s+goal(?:s|\s+mode)?/i.test(helpText);
}

export const GOAL_CAPABILITY_COMMANDS: Partial<Record<AgentType, string>> = {
    claude: 'claude',
    codex: 'codex',
    antigravity: 'agy',
};
