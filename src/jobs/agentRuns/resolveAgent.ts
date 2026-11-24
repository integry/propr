import type { Logger } from 'pino';
import { AgentRegistry, type Agent, type StoredAgentDefinition } from '@propr/core';
import { resolveDefaultAgentAndModel } from '../prCommentAgentUtils.js';

export interface ResolvedAgentRunAgent {
    agent: Pick<Agent, 'executeTask'>;
    alias: string;
    model: string | undefined;
    /** The agent's own runtime setting, so its MCP grant is planned for the runtime that will run it. */
    runtime?: string;
}

function runtimeOf(agent: Agent): { runtime?: string } {
    const runtime = agent.config.runtime?.trim();
    return runtime ? { runtime } : {};
}

/** The definition's agent, or the configured default agent when it names none. */
export async function defaultResolveAgent(definition: StoredAgentDefinition, log: Logger): Promise<ResolvedAgentRunAgent> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    if (definition.agentAlias === null) {
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, log);
        const agent = registry.getAgentByAlias(resolvedAlias);
        if (!agent) throw new Error(`Configured default agent not found: ${resolvedAlias}`);
        return { agent, alias: resolvedAlias, model: resolvedModel, ...runtimeOf(agent) };
    }
    const agent = registry.getAgentByAlias(definition.agentAlias);
    if (!agent) throw new Error(`Agent not found: ${definition.agentAlias}`);
    return { agent, alias: definition.agentAlias, model: definition.modelName ?? agent.config.defaultModel ?? undefined, ...runtimeOf(agent) };
}

