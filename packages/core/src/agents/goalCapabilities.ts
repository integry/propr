import { executeDockerCommand } from '../claude/docker/dockerExecutor.js';
import type { Agent, AgentType } from './types.js';

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

function unsupportedCapability(agent: Agent, reason: string): GoalCapability {
    return {
        agentId: agent.config.id,
        agentAlias: agent.config.alias,
        agentType: agent.config.type,
        goalCapable: false,
        reason,
    };
}

/** Capability-probe one exact configured image without assuming provider support. */
export async function probeGoalCapability(agent: Agent): Promise<GoalCapability> {
    const command = GOAL_CAPABILITY_COMMANDS[agent.config.type];
    if (!agent.goalCapable || !command) {
        return unsupportedCapability(agent, 'Provider does not implement native goal mode');
    }

    try {
        const result = await executeDockerCommand('docker', [
            'run', '--rm', '--entrypoint', command,
            agent.config.dockerImage, '--help',
        ], { timeout: 30_000 });
        const supported = result.exitCode === 0
            && helpAdvertisesNativeGoal(`${result.stdout}\n${result.stderr}`);
        return supported
            ? {
                agentId: agent.config.id,
                agentAlias: agent.config.alias,
                agentType: agent.config.type,
                goalCapable: true,
            }
            : unsupportedCapability(agent, 'Pinned CLI does not advertise native /goal support');
    } catch (error) {
        return unsupportedCapability(agent, `Capability probe failed: ${(error as Error).message}`);
    }
}

export class GoalCapabilityProbe {
    private cache = new Map<string, GoalCapability>();

    clear(): void {
        this.cache.clear();
    }

    async getAll(agents: Agent[]): Promise<GoalCapability[]> {
        return Promise.all(agents.map(async agent => {
            const cached = this.cache.get(agent.config.id);
            if (cached) return cached;
            const capability = await probeGoalCapability(agent);
            this.cache.set(agent.config.id, capability);
            return capability;
        }));
    }
}
