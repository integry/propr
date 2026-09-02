import fs from 'node:fs';
import path from 'node:path';
import { executeDockerCommand } from '../claude/docker/dockerExecutor.js';
import { resolveConfigPath } from '../config/configManager.js';
import { parseAntigravityJsonl } from './impl/utils/antigravityOutputParser.js';
import type { Agent, AgentType } from './types.js';

export interface GoalCapability {
    agentId: string;
    agentAlias: string;
    agentType: AgentType;
    goalCapable: boolean;
    lifecycle: {
        launch: 'native-goal' | 'goal-prompt';
        resume: 'native-goal' | 'whole-session';
        runningInput: 'live-steer' | 'safe-boundary-resume';
    } | null;
    controls: {
        liveInput: boolean;
        inputAtBoundary: boolean;
        modelAtBoundary: boolean;
        pauseAtBoundary: boolean;
    };
    reason?: string;
}

function controlsFor(agent: Agent): GoalCapability['controls'] {
    return agent.config.type === 'codex'
        ? { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true }
        : { liveInput: false, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true };
}

function lifecycleFor(agent: Agent): NonNullable<GoalCapability['lifecycle']> {
    return agent.config.type === 'codex'
        ? { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' }
        : { launch: 'goal-prompt', resume: 'whole-session', runningInput: 'safe-boundary-resume' };
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
    is_error?: boolean;
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
    const goalProbes = [2, 3, 4, 5].map(id => messages.find(message => message.id === id));
    if (!initialized || goalProbes.some(probe => !probe)) return false;
    return goalProbes.every(probe => probe?.error?.code !== -32601
        && !/method not found|unknown method/i.test(probe?.error?.message || ''));
}

export function claudeSessionIdentity(output: string): string | undefined {
    const init = parseJsonLines(output).find(message =>
        message.type === 'system' && message.subtype === 'init');
    return init?.session_id;
}

function claudeInvocationSucceeded(output: string): boolean {
    return parseJsonLines(output).some(message => message.type === 'result' && message.is_error !== true);
}

export function antigravityConversationIdentity(output: string): string | undefined {
    const parsed = parseAntigravityJsonl(output);
    return parsed.hasStreamEnvelopes && parsed.terminalStatus === 'success' && !parsed.protocolError
        ? parsed.conversationId
        : undefined;
}

function unsupportedCapability(agent: Agent, reason: string): GoalCapability {
    return {
        agentId: agent.config.id,
        agentAlias: agent.config.alias,
        agentType: agent.config.type,
        goalCapable: false,
        lifecycle: null,
        controls: { liveInput: false, inputAtBoundary: false, modelAtBoundary: false, pauseAtBoundary: false },
        reason,
    };
}

function dockerConfigMount(agent: Agent): string[] {
    const configPath = resolveConfigPath(agent.config.configPath);
    const target = agent.config.type === 'codex' ? '/home/node/.codex' : '/home/node/.claude';
    return ['-v', `${configPath}:${target}:rw`];
}

async function probeCodex(agent: Agent): Promise<GoalCapability> {
    const probeThreadId = '00000000-0000-0000-0000-000000000000';
    const handshake = [
        JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'propr', title: 'ProPR', version: '1' } } }),
        JSON.stringify({ method: 'initialized', params: {} }),
        JSON.stringify({ method: 'thread/goal/get', id: 2, params: { threadId: probeThreadId } }),
        JSON.stringify({ method: 'thread/goal/set', id: 3, params: { threadId: probeThreadId, status: 'paused' } }),
        JSON.stringify({ method: 'thread/goal/set', id: 4, params: { threadId: probeThreadId, status: 'active' } }),
        JSON.stringify({ method: 'thread/goal/clear', id: 5, params: { threadId: probeThreadId } }),
        '',
    ].join('\n');
    const result = await executeDockerCommand('docker', [
        'run', '--rm', '-i', '--entrypoint', 'codex',
        ...dockerConfigMount(agent), agent.config.dockerImage, 'app-server',
    ], { timeout: 30_000, stdinData: handshake });
    return result.exitCode === 0 && codexHandshakeSupportsNativeGoal(result.stdout)
        ? { agentId: agent.config.id, agentAlias: agent.config.alias, agentType: agent.config.type, goalCapable: true, lifecycle: lifecycleFor(agent), controls: controlsFor(agent) }
        : unsupportedCapability(agent, 'Pinned Codex App Server did not expose native goal get/pause/resume/clear controls');
}

async function probeClaude(agent: Agent): Promise<GoalCapability> {
    const baseArgs = ['run', '--rm', '-i', '--entrypoint', 'claude', ...dockerConfigMount(agent), agent.config.dockerImage];
    const initial = await executeDockerCommand('docker', [
        ...baseArgs, '-p', '-', '--output-format', 'stream-json', '--verbose', '--max-turns', '1',
    ], { timeout: 120_000, stdinData: '/goal Reply with GOAL_OK only.' });
    const sessionId = claudeSessionIdentity(initial.stdout);
    if (initial.exitCode !== 0 || !sessionId || !claudeInvocationSucceeded(initial.stdout)) {
        return unsupportedCapability(agent, 'Pinned Claude runtime did not persist its initial goal session identity');
    }

    const resumed = await executeDockerCommand('docker', [
        ...baseArgs, '-p', '-', '--resume', sessionId,
        '--output-format', 'stream-json', '--verbose', '--max-turns', '1',
    ], { timeout: 120_000, stdinData: 'Reply with OK only.' });
    const resumedSessionId = claudeSessionIdentity(resumed.stdout);
    return resumed.exitCode === 0 && resumedSessionId === sessionId && claudeInvocationSucceeded(resumed.stdout)
        ? { agentId: agent.config.id, agentAlias: agent.config.alias, agentType: agent.config.type, goalCapable: true, lifecycle: lifecycleFor(agent), controls: controlsFor(agent) }
        : unsupportedCapability(agent, 'Pinned Claude runtime did not resume the exact noninteractive session');
}

async function probeAntigravity(agent: Agent): Promise<GoalCapability> {
    const configuredPath = resolveConfigPath(agent.config.configPath);
    const siblingGeminiPath = configuredPath.endsWith(`${path.sep}.antigravity`)
        ? path.join(path.dirname(configuredPath), '.gemini')
        : configuredPath;
    const configPath = fs.existsSync(siblingGeminiPath) ? siblingGeminiPath : configuredPath;
    const baseArgs = [
        'run', '--rm', '-i', '--user', '0:0',
        '-v', `${configPath}:/home/node/.gemini:rw`,
        '-e', 'ANTIGRAVITY_CLI=1', '-e', 'ANTIGRAVITY_CLI_TRUST_WORKSPACE=true',
        agent.config.dockerImage, 'agy', '--dangerously-skip-permissions', '--output-format', 'stream-json',
    ];
    const initial = await executeDockerCommand('docker', baseArgs, {
        timeout: 120_000,
        stdinData: '/goal Reply with GOAL_OK only.',
    });
    const conversationId = antigravityConversationIdentity(initial.stdout);
    if (initial.exitCode !== 0 || !conversationId) {
        return unsupportedCapability(agent, 'Pinned Antigravity runtime did not persist its initial goal conversation identity');
    }
    const resumed = await executeDockerCommand('docker', [...baseArgs, '--conversation', conversationId], {
        timeout: 120_000,
        stdinData: 'Reply with RESUME_OK only.',
    });
    return resumed.exitCode === 0 && antigravityConversationIdentity(resumed.stdout) === conversationId
        ? { agentId: agent.config.id, agentAlias: agent.config.alias, agentType: agent.config.type, goalCapable: true, lifecycle: lifecycleFor(agent), controls: controlsFor(agent) }
        : unsupportedCapability(agent, 'Pinned Antigravity runtime did not resume the exact whole conversation');
}

/** Capability-probe the configured runtime using each provider's real protocol. */
export async function probeGoalCapability(agent: Agent): Promise<GoalCapability> {
    if (!agent.goalCapable) return unsupportedCapability(agent, 'Provider does not implement goal-session mode');
    try {
        if (agent.config.type === 'codex') return await probeCodex(agent);
        if (agent.config.type === 'claude') return await probeClaude(agent);
        if (agent.config.type === 'antigravity') return await probeAntigravity(agent);
        return unsupportedCapability(agent, 'Provider has no proven goal-session transport');
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
