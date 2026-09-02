import { executeDockerCommand } from '../claude/docker/dockerExecutor.js';
import { resolveConfigPath } from '../config/configManager.js';
import type { Agent, AgentType } from './types.js';

export interface GoalCapability {
    agentId: string;
    agentAlias: string;
    agentType: AgentType;
    goalCapable: boolean;
    reason?: string;
}

export const GOAL_CAPABILITY_COMMANDS: Partial<Record<AgentType, string>> = {
    claude: 'claude',
    codex: 'codex',
    antigravity: 'agy',
};

interface JsonMessage {
    id?: number;
    type?: string;
    subtype?: string;
    session_id?: string;
    slash_commands?: string[];
    result?: unknown;
    error?: { code?: number; message?: string };
}

function parseJsonLines(output: string): JsonMessage[] {
    const messages: JsonMessage[] = [];
    for (const line of output.split('\n')) {
        try { messages.push(JSON.parse(line) as JsonMessage); } catch { /* provider diagnostic */ }
    }
    return messages;
}

export function codexHandshakeSupportsNativeGoal(output: string): boolean {
    const messages = parseJsonLines(output);
    const initialized = messages.some(message => message.id === 1 && message.result !== undefined && !message.error);
    const goalProbe = messages.find(message => message.id === 2);
    if (!initialized || !goalProbe) return false;
    const methodMissing = goalProbe.error?.code === -32601
        || /method not found|unknown method/i.test(goalProbe.error?.message || '');
    return !methodMissing;
}

export function claudeInitSupportsNativeGoal(output: string): { supported: boolean; sessionId?: string } {
    const init = parseJsonLines(output).find(message =>
        message.type === 'system' && message.subtype === 'init');
    const commands = init?.slash_commands ?? [];
    return {
        supported: commands.some(command => command.replace(/^\//, '') === 'goal'),
        sessionId: init?.session_id,
    };
}

function unsupportedCapability(agent: Agent, reason: string): GoalCapability {
    return {
        agentId: agent.config.id,
        agentAlias: agent.config.alias,
        agentType: agent.config.type,
        goalCapable: false,
        reason,
    };
}

function dockerConfigMount(agent: Agent): string[] {
    const configPath = resolveConfigPath(agent.config.configPath);
    const target = agent.config.type === 'codex' ? '/home/node/.codex' : '/home/node/.claude';
    return ['-v', `${configPath}:${target}:rw`];
}

async function probeCodex(agent: Agent): Promise<GoalCapability> {
    const handshake = [
        JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'propr', title: 'ProPR', version: '1' } } }),
        JSON.stringify({ method: 'initialized', params: {} }),
        JSON.stringify({ method: 'thread/goal/get', id: 2, params: { threadId: 'propr-capability-probe' } }),
        '',
    ].join('\n');
    const result = await executeDockerCommand('docker', [
        'run', '--rm', '-i', '--entrypoint', 'codex',
        ...dockerConfigMount(agent), agent.config.dockerImage, 'app-server',
    ], { timeout: 30_000, stdinData: handshake });
    return codexHandshakeSupportsNativeGoal(result.stdout)
        ? { agentId: agent.config.id, agentAlias: agent.config.alias, agentType: agent.config.type, goalCapable: true }
        : unsupportedCapability(agent, 'Pinned Codex App Server did not complete the native goal protocol handshake');
}

async function probeClaude(agent: Agent): Promise<GoalCapability> {
    const baseArgs = ['run', '--rm', '-i', '--entrypoint', 'claude', ...dockerConfigMount(agent), agent.config.dockerImage];
    const initial = await executeDockerCommand('docker', [
        ...baseArgs, '-p', '-', '--output-format', 'stream-json', '--verbose', '--max-turns', '1',
    ], { timeout: 120_000, stdinData: 'Reply with OK only.' });
    const init = claudeInitSupportsNativeGoal(initial.stdout);
    if (!init.supported || !init.sessionId) {
        return unsupportedCapability(agent, 'Pinned Claude runtime init metadata does not expose native /goal');
    }

    const resumed = await executeDockerCommand('docker', [
        ...baseArgs, '-p', '-', '--resume', init.sessionId,
        '--output-format', 'stream-json', '--verbose', '--max-turns', '1',
    ], { timeout: 120_000, stdinData: 'Reply with OK only.' });
    const resumeInit = claudeInitSupportsNativeGoal(resumed.stdout);
    return resumed.exitCode === 0 && resumeInit.sessionId === init.sessionId
        ? { agentId: agent.config.id, agentAlias: agent.config.alias, agentType: agent.config.type, goalCapable: true }
        : unsupportedCapability(agent, 'Pinned Claude runtime did not resume the exact noninteractive session');
}

/** Capability-probe the configured runtime using each provider's real protocol. */
export async function probeGoalCapability(agent: Agent): Promise<GoalCapability> {
    if (!agent.goalCapable) return unsupportedCapability(agent, 'Provider does not implement native goal mode');
    try {
        if (agent.config.type === 'codex') return await probeCodex(agent);
        if (agent.config.type === 'claude') return await probeClaude(agent);
        return unsupportedCapability(agent, 'Pinned Antigravity runtime has no proven native goal plus exact-resume protocol');
    } catch (error) {
        return unsupportedCapability(agent, `Capability handshake failed: ${(error as Error).message}`);
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
