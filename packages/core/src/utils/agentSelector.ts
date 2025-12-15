
import { AgentRegistry } from '../agents/AgentRegistry.js';
import { Agent } from '../agents/types.js';
import logger from './logger.js';

export interface ResolvedAgent {
    agent: Agent;
    model: string;
}

/**
 * Resolves the agent and model to use based on issue labels.
 * Strategy:
 * 1. Look for 'llm-<alias>' label.
 * 2. If found, verify alias exists in Registry.
 * 3. Look for 'model-<modelId>' label (optional override).
 * 4. If no 'model-*' label, use agent's default model or first supported model.
 * 5. If no 'llm-*' label, returns null (caller should use system default).
 */
export function resolveAgentFromLabels(labels: string[]): ResolvedAgent | null {
    const registry = AgentRegistry.getInstance();
    
    // 1. Find Agent Alias
    const agentLabel = labels.find(l => l.startsWith('llm-'));
    if (!agentLabel) return null;

    const alias = agentLabel.replace('llm-', '');
    const agent = registry.getAgentByAlias(alias);
    
    if (!agent) {
        logger.warn({ alias, labels }, 'Label referenced unknown agent alias');
        return null;
    }

    // 2. Find Model override
    let model = agent.config.defaultModel || agent.config.supportedModels[0];
    const modelLabel = labels.find(l => l.startsWith('model-'));
    if (modelLabel) {
        const reqModel = modelLabel.replace('model-', '');
        // Validate model is supported by this agent
        if (agent.config.supportedModels.includes(reqModel)) {
            model = reqModel;
        } else {
            logger.warn({ reqModel, supported: agent.config.supportedModels }, 'Requested model not supported by agent, using default');
        }
    }

    if (!model) {
        logger.error({ alias, agentConfig: agent.config }, 'Agent has no default model and no supported models listed');
        return null;
    }

    return { agent, model };
}
