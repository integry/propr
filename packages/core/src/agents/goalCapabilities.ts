import { executeDockerCommand, type ExecutionResult } from '../claude/docker/dockerExecutor.js';
import { parseAntigravityJsonl } from './impl/utils/antigravityOutputParser.js';
import { hasNativeGoalControl } from '../goals.js';
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

type DockerExecutor = (
    command: string,
    args: string[],
    options?: Parameters<typeof executeDockerCommand>[2],
) => Promise<ExecutionResult>;

const REQUIRED_CODEX_GOAL_METHODS = [
    'thread/goal/get',
    'thread/goal/set',
    'thread/goal/clear',
] as const;
const FAILURE_CACHE_TTL_MS = 30_000;

function controlsFor(agent: Agent): GoalCapability['controls'] {
    return hasNativeGoalControl(agent.config.type)
        ? { liveInput: true, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true }
        : { liveInput: false, inputAtBoundary: true, modelAtBoundary: true, pauseAtBoundary: true };
}

function lifecycleFor(agent: Agent): NonNullable<GoalCapability['lifecycle']> {
    return hasNativeGoalControl(agent.config.type)
        ? { launch: 'native-goal', resume: 'native-goal', runningInput: 'live-steer' }
        : { launch: 'goal-prompt', resume: 'whole-session', runningInput: 'safe-boundary-resume' };
}

function supportedCapability(agent: Agent): GoalCapability {
    return {
        agentId: agent.config.id,
        agentAlias: agent.config.alias,
        agentType: agent.config.type,
        goalCapable: true,
        lifecycle: lifecycleFor(agent),
        controls: controlsFor(agent),
    };
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

/** Retained for consumers that inspect recorded legacy handshakes. New probes use the schema. */
export function codexHandshakeSupportsNativeGoal(output: string): boolean {
    const messages = parseJsonLines(output);
    const initialized = messages.some(message => message.id === 1 && message.result !== undefined && !message.error);
    const goalProbes = [2, 3, 4, 5].map(id => messages.find(message => message.id === id));
    if (!initialized || goalProbes.some(probe => !probe)) return false;
    return goalProbes.every(probe => probe?.error?.code !== -32601
        && !/method not found|unknown method/i.test(probe?.error?.message || ''));
}

function collectJsonStrings(value: unknown, strings: Set<string>): void {
    if (typeof value === 'string') {
        strings.add(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectJsonStrings(item, strings);
        return;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) collectJsonStrings(item, strings);
    }
}

/** Verify all native goal methods from Codex's generated experimental protocol schema. */
export function codexSchemaSupportsNativeGoal(output: string): boolean {
    try {
        const strings = new Set<string>();
        collectJsonStrings(JSON.parse(output), strings);
        return REQUIRED_CODEX_GOAL_METHODS.every(method => strings.has(method));
    } catch {
        return false;
    }
}

function cliHelpHasOption(output: string, option: string): boolean {
    const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*(?:-[^\\s,]+,?\\s+)?${escaped}(?:[\\s=<\\[]|$)`, 'm').test(output);
}

/** Claude goal mode needs persisted noninteractive sessions and exact-session resume. */
export function claudeHelpSupportsWholeSession(output: string): boolean {
    return ['--print', '--resume', '--output-format', '--no-session-persistence']
        .every(option => cliHelpHasOption(output, option));
}

/**
 * Claude native goals run `/goal` inside a live stream-json session: ProPR
 * assigns the session identity up front, steers input over stdin, and resumes
 * the exact session (which restores its goal) after a boundary.
 */
export function claudeHelpSupportsNativeGoal(output: string): boolean {
    return ['--print', '--resume', '--session-id', '--input-format', '--output-format']
        .every(option => cliHelpHasOption(output, option));
}

const CLAUDE_GOAL_PROBE_SEPARATOR = '===PROPR-CLAUDE-GOAL-PROBE===';

/**
 * `claude -p /goal` is a local command: with no goal set it prints its usage
 * without authentication or network access. Runtimes without a noninteractive
 * `/goal` send the text to the model instead, which fails offline.
 */
export function claudeGoalCommandProbeSucceeded(output: string): boolean {
    for (const line of output.split('\n')) {
        try {
            const message = JSON.parse(line) as { type?: string; result?: unknown };
            if (message.type === 'result' && typeof message.result === 'string') {
                return /No goal set\. Usage: `\/goal <condition>`/.test(message.result);
            }
        } catch { /* help text and entrypoint diagnostics */ }
    }
    return false;
}

/** Antigravity goal mode needs noninteractive output and exact-conversation resume. */
export function antigravityHelpSupportsWholeSession(output: string): boolean {
    return ['--print', '--conversation', '--output-format', '--disable-slash-commands']
        .every(option => cliHelpHasOption(output, option));
}

export function claudeSessionIdentity(output: string): string | undefined {
    const init = parseJsonLines(output).find(message =>
        message.type === 'system' && message.subtype === 'init');
    return init?.session_id;
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

function introspectionOutput(result: ExecutionResult): string {
    return `${result.stdout}\n${result.stderr}`;
}

async function probeCodex(agent: Agent, executor: DockerExecutor): Promise<GoalCapability> {
    const schemaCommand = [
        'set -eu',
        'schema_dir="$(mktemp -d)"',
        'codex app-server generate-json-schema --experimental --out "$schema_dir" >/dev/null',
        'cat "$schema_dir/ClientRequest.json"',
    ].join('; ');
    const result = await executor('docker', [
        'run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh',
        agent.config.dockerImage, '-c', schemaCommand,
    ], { timeout: 30_000 });
    return result.exitCode === 0 && codexSchemaSupportsNativeGoal(result.stdout)
        ? supportedCapability(agent)
        : unsupportedCapability(agent, 'Pinned Codex App Server schema does not expose native goal get, set, and clear methods');
}

async function probeClaude(agent: Agent, executor: DockerExecutor): Promise<GoalCapability> {
    const probeCommand = [
        'claude --help',
        `echo '${CLAUDE_GOAL_PROBE_SEPARATOR}'`,
        'claude -p /goal --output-format stream-json --verbose --no-session-persistence',
    ].join('; ');
    const result = await executor('docker', [
        'run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh',
        agent.config.dockerImage, '-c', probeCommand,
    ], { timeout: 60_000 });
    const [help, goalProbe = ''] = result.stdout.split(CLAUDE_GOAL_PROBE_SEPARATOR);
    if (!claudeHelpSupportsNativeGoal(`${help}\n${result.stderr}`)) {
        return unsupportedCapability(agent, 'Pinned Claude runtime does not expose stream-json sessions with --session-id and exact --resume support');
    }
    return claudeGoalCommandProbeSucceeded(goalProbe)
        ? supportedCapability(agent)
        : unsupportedCapability(agent, 'Pinned Claude runtime does not provide a noninteractive native /goal command');
}

async function probeAntigravity(agent: Agent, executor: DockerExecutor): Promise<GoalCapability> {
    const result = await executor('docker', [
        'run', '--rm', '--network', 'none', '--entrypoint', 'agy',
        agent.config.dockerImage, '--help',
    ], { timeout: 30_000 });
    return result.exitCode === 0 && antigravityHelpSupportsWholeSession(introspectionOutput(result))
        ? supportedCapability(agent)
        : unsupportedCapability(agent, 'Pinned Antigravity runtime does not expose noninteractive --conversation resume and slash-command support');
}

/** Capability-probe the configured runtime without authentication or provider inference. */
export async function probeGoalCapability(
    agent: Agent,
    executor: DockerExecutor = executeDockerCommand,
): Promise<GoalCapability> {
    if (!agent.goalCapable) return unsupportedCapability(agent, 'Provider does not implement goal-session mode');
    try {
        if (agent.config.type === 'codex') return await probeCodex(agent, executor);
        if (agent.config.type === 'claude') return await probeClaude(agent, executor);
        if (agent.config.type === 'antigravity') return await probeAntigravity(agent, executor);
        return unsupportedCapability(agent, 'Provider has no proven goal-session transport');
    } catch (error) {
        return unsupportedCapability(agent, `Capability introspection failed: ${(error as Error).message}`);
    }
}

interface CachedGoalCapability {
    capability: GoalCapability;
    expiresAt: number;
}

export class GoalCapabilityProbe {
    private cache = new Map<string, CachedGoalCapability>();

    constructor(
        private readonly failureCacheTtlMs = FAILURE_CACHE_TTL_MS,
        private readonly now: () => number = Date.now,
        private readonly probe: (agent: Agent) => Promise<GoalCapability> = probeGoalCapability,
    ) {}

    clear(): void {
        this.cache.clear();
    }

    async getAll(agents: Agent[], options: { force?: boolean } = {}): Promise<GoalCapability[]> {
        return Promise.all(agents.map(async agent => {
            const cached = this.cache.get(agent.config.id);
            if (!options.force && cached && cached.expiresAt > this.now()) return cached.capability;
            const capability = await this.probe(agent);
            this.cache.set(agent.config.id, {
                capability,
                expiresAt: capability.goalCapable ? Number.POSITIVE_INFINITY : this.now() + this.failureCacheTtlMs,
            });
            return capability;
        }));
    }
}
