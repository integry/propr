import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import { Agent, AgentConfig } from './types.js';
import { ClaudeAgent } from './impl/ClaudeAgent.js';
import { CodexAgent } from './impl/CodexAgent.js';
import { GeminiAgent } from './impl/GeminiAgent.js';
import * as configManager from '../config/configManager.js';

/**
 * AgentRegistry manages the lifecycle of agent instances.
 * It follows the Singleton pattern to ensure a single source of truth
 * for all agent configurations and instances.
 */
export class AgentRegistry {
    private static instance: AgentRegistry;
    private agents: Map<string, Agent> = new Map(); // Map by ID
    private agentsByAlias: Map<string, Agent> = new Map(); // Map by Alias
    private initialized = false;

    private constructor() {
        // Private constructor for singleton pattern
    }

    /**
     * Gets the singleton instance of AgentRegistry.
     */
    static getInstance(): AgentRegistry {
        if (!AgentRegistry.instance) {
            AgentRegistry.instance = new AgentRegistry();
        }
        return AgentRegistry.instance;
    }

    /**
     * Reloads configuration from configManager and instantiates agents.
     * This should be called at startup and whenever configuration changes.
     */
    async refresh(): Promise<void> {
        logger.info('Refreshing agent registry...');

        try {
            const configs = await configManager.loadAgents();

            // Clear existing maps
            this.agents.clear();
            this.agentsByAlias.clear();

            if (configs.length === 0) {
                // Fallback: Create default Claude agent from ENV vars if no config exists
                logger.info('No agents configured, creating default Claude agent from environment');
                this.registerDefaultAgent();
                this.initialized = true;
                return;
            }

            for (const config of configs) {
                if (!config.enabled) {
                    logger.debug({ agentAlias: config.alias }, 'Skipping disabled agent');
                    continue;
                }

                try {
                    // Validate alias uniqueness before creating
                    if (this.agentsByAlias.has(config.alias)) {
                        logger.error({
                            agentAlias: config.alias,
                            existingId: this.agentsByAlias.get(config.alias)?.config.id,
                            newId: config.id
                        }, 'Duplicate agent alias detected, skipping');
                        continue;
                    }

                    const agent = this.createAgentFromConfig(config);
                    this.agents.set(config.id, agent);
                    this.agentsByAlias.set(config.alias, agent);

                    logger.info({
                        agentId: config.id,
                        agentAlias: config.alias,
                        agentType: config.type,
                        dockerImage: config.dockerImage
                    }, 'Agent registered successfully');
                } catch (error) {
                    const err = error as Error;
                    logger.error({
                        error: err.message,
                        agentAlias: config.alias,
                        agentType: config.type
                    }, 'Failed to initialize agent');
                }
            }

            this.initialized = true;
            logger.info({
                totalAgents: this.agents.size,
                enabledAgents: Array.from(this.agentsByAlias.keys())
            }, 'Agent registry refreshed successfully');
        } catch (error) {
            const err = error as Error;
            logger.error({ error: err.message }, 'Failed to refresh agent registry, using default agent');

            // Fallback to default agent on error
            this.agents.clear();
            this.agentsByAlias.clear();
            this.registerDefaultAgent();
            this.initialized = true;
        }
    }

    /**
     * Gets an agent by its unique ID.
     */
    getAgentById(id: string): Agent | undefined {
        return this.agents.get(id);
    }

    /**
     * Gets an agent by its human-readable alias.
     */
    getAgentByAlias(alias: string): Agent | undefined {
        return this.agentsByAlias.get(alias);
    }

    /**
     * Gets the default agent (first available or 'default' alias).
     */
    getDefaultAgent(): Agent | undefined {
        // First try to get agent with 'default' alias
        const defaultAgent = this.agentsByAlias.get('default');
        if (defaultAgent) {
            return defaultAgent;
        }

        // Otherwise return the first available agent
        return this.getAllAgents()[0];
    }

    /**
     * Gets all registered agent instances.
     */
    getAllAgents(): Agent[] {
        return Array.from(this.agents.values());
    }

    /**
     * Gets all agent configurations (including disabled ones from config).
     */
    async getAllConfigs(): Promise<AgentConfig[]> {
        try {
            return await configManager.loadAgents();
        } catch (error) {
            const err = error as Error;
            logger.error({ error: err.message }, 'Failed to load agent configs');
            return [];
        }
    }

    /**
     * Checks if the registry has been initialized.
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * Ensures the registry is initialized, refreshing if necessary.
     */
    async ensureInitialized(): Promise<void> {
        if (!this.initialized) {
            await this.refresh();
        }
    }

    /**
     * Creates an agent instance from configuration.
     * This is the factory method that handles different agent types.
     */
    private createAgentFromConfig(config: AgentConfig): Agent {
        switch (config.type) {
            case 'claude':
                return new ClaudeAgent(config);
            case 'codex':
                return new CodexAgent(config);
            case 'gemini':
                return new GeminiAgent(config);
            default:
                throw new Error(`Unknown agent type: ${config.type}`);
        }
    }

    /**
     * Registers a default Claude agent using environment variables.
     * This is the fallback when no agents are configured.
     */
    private registerDefaultAgent(): void {
        const defaultConfig: AgentConfig = {
            id: 'default-claude-agent',
            type: 'claude',
            alias: 'default',
            enabled: true,
            dockerImage: process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest',
            configPath: process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude'),
            supportedModels: [
                'claude-opus-4-5',
                'claude-sonnet-4-5',
                'claude-haiku-4-5',
                'claude-opus-4-20250514',
                'claude-sonnet-4-20250514'
            ],
            defaultModel: process.env.CLAUDE_MODEL || undefined
        };

        const agent = new ClaudeAgent(defaultConfig);
        this.agents.set(defaultConfig.id, agent);
        this.agentsByAlias.set(defaultConfig.alias, agent);

        logger.info({
            agentId: defaultConfig.id,
            agentAlias: defaultConfig.alias,
            dockerImage: defaultConfig.dockerImage
        }, 'Default Claude agent registered');
    }
}

// Export singleton instance getter for convenience
export const getAgentRegistry = (): AgentRegistry => AgentRegistry.getInstance();
