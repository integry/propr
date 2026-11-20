import { db } from '../db/connection.js';
import * as configManager from '../config/configManager.js';
import logger from '../utils/logger.js';
import type { Agent, AgentConfig } from './types.js';
import { AGENT_DEFAULT_VERSIONS } from './version/types.js';
import type { AgentType } from './types.js';

/** The `agent.runtime` timeline event: the agent CLI version and image a run used. */
export interface AgentRuntimeEvent {
    agentAlias: string;
    agentType: string;
    cliVersion: string | null;
    image: string;
    /** The configured CLI version when it differs from the one this run used. */
    configuredCliVersion?: string;
}

const RECENT_HISTORY_LIMIT = 50;
const instrumented = new WeakSet<Agent>();

const cliVersionOf = (config: Pick<AgentConfig, 'type' | 'cliVersionResolved'>): string | null =>
    config.cliVersionResolved || AGENT_DEFAULT_VERSIONS[config.type as AgentType] || null;

export function agentRuntimeEvent(runtime: AgentRuntimeEvent): { reason: string; metadata: Record<string, unknown> } {
    const version = runtime.cliVersion ? `${runtime.agentType} CLI ${runtime.cliVersion}` : `${runtime.agentType} CLI`;
    const reason = runtime.configuredCliVersion
        ? `Agent ${runtime.agentAlias} ran ${version}; configured ${runtime.configuredCliVersion} was still being prepared`
        : `Agent ${runtime.agentAlias} ran ${version}`;
    return { reason, metadata: { event: 'agent.runtime', agentRuntime: runtime } };
}

function parseMetadata(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
        try { return parseMetadata(JSON.parse(value)); } catch { return {}; }
    }
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

const sameRuntime = (left: unknown, right: AgentRuntimeEvent): boolean => {
    const previous = left as Partial<AgentRuntimeEvent> | undefined;
    return !!previous && previous.agentAlias === right.agentAlias && previous.cliVersion === right.cliVersion
        && previous.image === right.image && previous.configuredCliVersion === right.configuredCliVersion;
};

async function configuredVersionFor(config: AgentConfig): Promise<string | null> {
    try {
        const configured = (await configManager.loadAgents()).find(agent => agent.alias === config.alias && agent.type === config.type);
        return configured?.enabled ? cliVersionOf(configured) : null;
    } catch {
        return null;
    }
}

/**
 * Records which CLI version and image a task's run used, once per distinct
 * runtime. A run started while a newly configured version is still being
 * prepared keeps the previous image and says so here.
 */
export async function recordAgentRuntimeEvent(taskId: string, config: AgentConfig): Promise<void> {
    try {
        const cliVersion = cliVersionOf(config);
        const configured = await configuredVersionFor(config);
        const runtime: AgentRuntimeEvent = {
            agentAlias: config.alias,
            agentType: config.type,
            cliVersion,
            image: config.dockerImage,
            ...(configured && configured !== cliVersion ? { configuredCliVersion: configured } : {}),
        };
        if (!await db('tasks').where({ task_id: taskId }).first('task_id')) return;
        const recent: Array<{ state?: string; metadata?: unknown }> = await db('task_history')
            .where({ task_id: taskId }).orderBy('timestamp', 'desc').orderBy('history_id', 'desc')
            .limit(RECENT_HISTORY_LIMIT).select('state', 'metadata');
        const lastRuntime = recent.map(row => parseMetadata(row.metadata)).find(metadata => metadata.event === 'agent.runtime');
        if (lastRuntime && sameRuntime(lastRuntime.agentRuntime, runtime)) return;
        const event = agentRuntimeEvent(runtime);
        await db('task_history').insert({
            task_id: taskId,
            // Written as the run starts; it must not read as a lifecycle change.
            state: recent[0]?.state ?? 'processing',
            timestamp: new Date().toISOString(),
            reason: event.reason,
            metadata: JSON.stringify(event.metadata),
        });
    } catch (error) {
        logger.warn({ taskId, agentAlias: config.alias, error: (error as Error).message }, 'Could not record agent runtime timeline event');
    }
}

/**
 * Makes every task run of this agent record its CLI version on the task
 * timeline before the run starts. Idempotent per agent instance.
 */
export function instrumentAgentRuntimeEvents<T extends Agent>(agent: T): T {
    if (instrumented.has(agent) || typeof agent.executeTask !== 'function') return agent;
    instrumented.add(agent);
    const execute = agent.executeTask.bind(agent);
    agent.executeTask = async options => {
        if (options?.taskId) await recordAgentRuntimeEvent(options.taskId, agent.config);
        return execute(options);
    };
    return agent;
}
