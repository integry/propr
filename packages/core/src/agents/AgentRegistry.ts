import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import { Agent, AgentConfig } from './types.js';
import { ClaudeAgent } from './impl/ClaudeAgent.js';
import { CodexAgent } from './impl/CodexAgent.js';
import { AntigravityAgent } from './impl/AntigravityAgent.js';
import { VibeAgent } from './impl/VibeAgent.js';
import * as configManager from '../config/configManager.js';
import { ensureAgentDockerImage, ensureVersionedAgentImage } from '../claude/docker/dockerExecutor.js';
import { closeConnection } from '../db/connection.js';
import { shutdownQueue } from '../queue/taskQueue.js';
import { computeContentHash, generateImageTag, getDockerTagComponent } from './version/versionService.js';
import { AGENT_DEFAULT_VERSIONS, AGENT_IMAGE_NAMES } from './version/types.js';

/**
 * AgentRegistry manages the lifecycle of agent instances.
 * It follows the Singleton pattern to ensure a single source of truth
 * for all agent configurations and instances.
 */
export class AgentRegistry {
    private static instance: AgentRegistry;
    private agents: Map<string, Agent> = new Map(); // Map by ID
    private agentsByAlias: Map<string, Agent> = new Map(); // Map by Alias
    private defaultAgentAlias: string | null = null; // From settings.default_agent_alias
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
            // Run migration to ensure all agents have version config
            await configManager.migrateAgentConfigs();

            const configs = await configManager.loadAgents();

            // Load the default_agent_alias from settings
            try {
                const settings = await configManager.loadSettings();
                this.defaultAgentAlias = (settings as Record<string, unknown>).default_agent_alias as string || null;
            } catch {
                this.defaultAgentAlias = null;
            }

            // Clear existing maps
            this.agents.clear();
            this.agentsByAlias.clear();

            if (configs.length === 0) {
                // Fallback: Create default Claude agent from ENV vars if no config exists
                logger.info('No agents configured, creating default Claude agent from environment');
                await this.registerDefaultAgent();
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

                    // Ensure Docker image exists before registering agent
                    const imageReady = await this.ensureAgentImage(config);

                    if (!imageReady) {
                        logger.error({
                            agentAlias: config.alias,
                            agentType: config.type,
                            dockerImage: config.dockerImage
                        }, 'Failed to ensure Docker image, skipping agent registration');
                        continue;
                    }

                    const agent = this.createAgentFromConfig(config);
                    this.agents.set(config.id, agent);
                    this.agentsByAlias.set(config.alias, agent);

                    logger.info({
                        agentId: config.id,
                        agentAlias: config.alias,
                        agentType: config.type,
                        dockerImage: config.dockerImage,
                        cliVersion: config.cliVersionResolved
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
            await this.registerDefaultAgent();
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
     * Gets the default agent based on settings, then fallback to 'default' alias or first available.
     * Resolution order:
     * 1. settings.default_agent_alias (configured in UI)
     * 2. Agent with 'default' alias
     * 3. First available (enabled) agent
     */
    getDefaultAgent(): Agent | undefined {
        // First try the configured default agent from settings
        if (this.defaultAgentAlias) {
            const configuredAgent = this.agentsByAlias.get(this.defaultAgentAlias);
            if (configuredAgent) {
                return configuredAgent;
            }
        }

        // Then try to get agent with 'default' alias
        const defaultAgent = this.agentsByAlias.get('default');
        if (defaultAgent) {
            return defaultAgent;
        }

        // No default agent configured — return undefined so callers handle the error explicitly
        return undefined;
    }

    /**
     * Sets the default agent alias (used when syncing from settings).
     */
    setDefaultAgentAlias(alias: string | null): void {
        this.defaultAgentAlias = alias;
    }

    /**
     * Gets the current default agent alias from the registry's cached settings.
     */
    getDefaultAgentAlias(): string | null {
        return this.defaultAgentAlias;
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
     * Ensures the Docker image for an agent config is ready.
     * Uses versioned image if version config is present, otherwise uses default.
     */
    private async ensureAgentImage(config: AgentConfig): Promise<boolean> {
        if (config.type === 'antigravity') {
            config.cliVersion = 'latest';
            config.cliVersionResolved = AGENT_DEFAULT_VERSIONS.antigravity;
        }
        const cliVersionResolved = config.cliVersionResolved;
        if (this.isManagedVersionedImage(config, cliVersionResolved)) {
            const contentHash = computeContentHash(config.type);
            const expectedImageTag = generateImageTag(config.type, cliVersionResolved!, contentHash);
            const result = await ensureVersionedAgentImage(
                config.type,
                cliVersionResolved!,
                contentHash
            );
            if (result.success) {
                config.dockerImage = result.imageTag || expectedImageTag;
            }
            return result.success;
        }

        // Prefer the user-configured dockerImage (pull-first, build fallback).
        // This matters for production images like propr/agent-claude:latest.
        // The versioned-build path below only works when Dockerfiles are present.
        if (config.dockerImage && await ensureAgentDockerImage(config.type, config.dockerImage)) {
            return true;
        }

        // Fallback: versioned build (dev flow) — requires Dockerfile on disk.
        if (config.cliVersionType && config.cliVersionResolved) {
            const contentHash = computeContentHash(config.type);
            const result = await ensureVersionedAgentImage(
                config.type,
                cliVersionResolved!,
                contentHash
            );
            if (result.success && result.imageTag !== config.dockerImage) {
                config.dockerImage = result.imageTag;
            }
            return result.success;
        }
        return false;
    }

    private isManagedVersionedImage(config: AgentConfig, cliVersionResolved = config.cliVersionResolved): boolean {
        if (!config.cliVersionType || !cliVersionResolved) return false;
        const managedImageName = AGENT_IMAGE_NAMES[config.type];
        if (!managedImageName || !config.dockerImage?.startsWith(`${managedImageName}:`)) return false;
        const tag = config.dockerImage.slice(managedImageName.length + 1);
        const versionTag = getDockerTagComponent(cliVersionResolved);
        return tag.startsWith(`${versionTag}-`) && /-[0-9a-f]{6}$/i.test(tag);
    }

    /**
     * Creates an agent instance from configuration.
     * This is the factory method that handles different agent types.
     */
    createAgentFromConfig(config: AgentConfig): Agent {
        switch (config.type) {
            case 'claude':
                return new ClaudeAgent(config);
            case 'codex':
                return new CodexAgent(config);
            case 'antigravity':
                return new AntigravityAgent(config);
            case 'vibe':
                return new VibeAgent(config);
            default:
                throw new Error(`Unknown agent type: ${config.type}`);
        }
    }

    /**
     * Registers a default Claude agent using environment variables.
     * This is the fallback when no agents are configured.
     */
    private async registerDefaultAgent(): Promise<void> {
        const defaultConfig: AgentConfig = {
            id: 'default-claude-agent',
            type: 'claude',
            alias: 'default',
            enabled: true,
            dockerImage: process.env.CLAUDE_DOCKER_IMAGE || 'propr/agent-claude:latest',
            configPath: process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude'),
            supportedModels: [
                'claude-opus-4-8',
                'claude-opus-4-7',
                'claude-opus-4-6',
                'claude-sonnet-4-6',
                'claude-opus-4-5-20251101',
                'claude-sonnet-4-5-20250929',
                'claude-haiku-4-5-20251001'
            ],
            defaultModel: process.env.CLAUDE_MODEL || undefined
        };

        // Ensure Docker image exists before registering
        const imageReady = await ensureAgentDockerImage(defaultConfig.type, defaultConfig.dockerImage);
        if (!imageReady) {
            logger.error({
                agentType: defaultConfig.type,
                dockerImage: defaultConfig.dockerImage
            }, 'Failed to ensure Docker image for default agent');
        }

        const agent = new ClaudeAgent(defaultConfig);
        this.agents.set(defaultConfig.id, agent);
        this.agentsByAlias.set(defaultConfig.alias, agent);

        logger.info({
            agentId: defaultConfig.id,
            agentAlias: defaultConfig.alias,
            dockerImage: defaultConfig.dockerImage
        }, 'Default Claude agent registered');
    }

    /**
     * Clean up resources and connections.
     * Should be called during shutdown or test cleanup.
     */
    async destroy(): Promise<void> {
        try {
            // Clear agents and state
            this.agents.clear();
            this.agentsByAlias.clear();
            this.initialized = false;

            // Close database connection
            await closeConnection();

            // Shutdown queues and Redis connections
            await shutdownQueue();

            logger.debug('AgentRegistry destroyed and cleaned up');
        } catch (error) {
            const err = error as Error;
            logger.error({ error: err.message }, 'Error during AgentRegistry cleanup');
            throw err;
        }
    }

    /**
     * Reset the singleton instance (for testing).
     * This will force a new instance to be created on next getInstance() call.
     */
    static async resetInstance(): Promise<void> {
        if (AgentRegistry.instance) {
            // Clean up the existing instance
            try {
                await AgentRegistry.instance.destroy();
            } catch (err) {
                const error = err as Error;
                logger.error({ error: error.message }, 'Error destroying AgentRegistry instance');
                throw err;
            }
        }
        AgentRegistry.instance = undefined as unknown as AgentRegistry;
    }
}

// Export singleton instance getter for convenience
export const getAgentRegistry = (): AgentRegistry => AgentRegistry.getInstance();
