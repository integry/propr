import * as configManager from '../config/configManager.js';
import logger from '../utils/logger.js';
import { resolveAgentRunAdmission } from './agentRunAdmission.js';
import { AGENT_RUN_ALIAS_LIMITS_ENV, agentRunAliasLimitProblems, type AgentRunAliasInventory } from './agentRunAliasLimits.js';

export interface AgentRunAdmissionPolicyDependencies {
    env?: NodeJS.ProcessEnv;
    loadInventory?: () => Promise<AgentRunAliasInventory>;
}

async function loadInventory(): Promise<AgentRunAliasInventory> {
    const [agents, synthetic] = await Promise.all([configManager.loadAgents(), configManager.loadSyntheticAgents()]);
    return { directAliases: agents.map(agent => agent.alias), syntheticAliases: synthetic.map(agent => agent.alias) };
}

/** Throws when the admission policy is malformed, is set without admission,
 * or names an alias that is not a configured direct agent. Called at worker
 * and API startup, which exit non-zero instead of leaving an agent uncapped. */
export async function validateAgentRunAdmissionPolicy(dependencies: AgentRunAdmissionPolicyDependencies = {}): Promise<void> {
    const config = resolveAgentRunAdmission(dependencies.env ?? process.env);
    if (!config?.aliasLimits) return;
    const problems = agentRunAliasLimitProblems(config.aliasLimits, await (dependencies.loadInventory ?? loadInventory)());
    if (problems.length) throw new Error(`Invalid ${AGENT_RUN_ALIAS_LIMITS_ENV}: ${problems.join('; ')}`);
    logger.info({ instance: config.instance, limit: config.limit, aliasLimits: config.aliasLimits }, 'Per-agent admission ceilings configured');
}

/** Agent aliases change at runtime through config events. Re-check and report
 * clearly without crashing: a renamed alias keeps running under the global
 * limit only (its ceiling no longer matches) until the policy is corrected. */
export async function revalidateAgentRunAdmissionPolicy(dependencies: AgentRunAdmissionPolicyDependencies = {}): Promise<boolean> {
    try {
        await validateAgentRunAdmissionPolicy(dependencies);
        return true;
    } catch (error) {
        logger.error({ error: (error as Error).message }, 'Agent-run admission policy no longer matches the configured agents; affected agents are limited only by the global agent-run limit until the policy is corrected');
        return false;
    }
}
