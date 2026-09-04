import logger from '../utils/logger.js';
import { Agent, AgentConfig } from './types.js';
import { ClaudeAgent } from './impl/ClaudeAgent.js';
import * as configManager from '../config/configManager.js';
import { executeDockerCommand } from '../claude/docker/dockerExecutor.js';
import { closeConnection } from '../db/connection.js';
import { shutdownQueue } from '../queue/taskQueue.js';
import { loadAgentRuntimePackageState } from './runtime/agentRuntimePackages.js';
import { SyntheticAgentRegistry, type BeginSyntheticRoutingOptions, type SyntheticRoutingSession } from './SyntheticAgentRegistry.js';
import { createAgentFromConfig } from './createAgentFromConfig.js';
import { resolveDefaultAgentConfig, resolveUnifiedAgentImage } from './agentImagePreparation.js';

export interface AgentRegistryOperationalStatus {
    unifiedAgentImage: {
        status: 'ready' | 'unavailable';
        imageTag?: string;
        error?: string;
        recordedAt?: string;
    };
}

const RUNTIME_PACKAGE_STATE_CHECK_INTERVAL_MS = 5000;
const UNIFIED_AGENT_IMAGE_RETRY_INTERVAL_MS = 60_000;

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
    private runtimePackagesUpdatedAt: string | undefined;
    private runtimePackageStateCheckAfter = 0;
    private runtimePackageStateUnavailable = false;
    private pendingRefresh: Promise<void> | null = null;
    private pendingRefreshPreparesImages = false;
    private pendingBackgroundRefresh: Promise<void> | null = null;
    private unavailableUnifiedAgentImage: { imageTag?: string; error: string; recordedAt: string } | null = null;
    private unifiedAgentImageRetryTimer: NodeJS.Timeout | null = null;
    private syntheticAgents = new SyntheticAgentRegistry(this.agents, this.agentsByAlias);

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
     * This is deliberately read-only with respect to Docker images. Request and
     * task paths may refresh the registry, but image preparation belongs to the
     * worker's startup/configuration lifecycle.
     */
    refresh(): Promise<void> {
        return this.requestRefresh(false);
    }

    /**
     * Prepares missing base and runtime-package images, then refreshes the
     * registry. The main worker calls this at startup and when agent version
     * configuration changes; ordinary registry consumers must use refresh().
     */
    prepareImagesAndRefresh(): Promise<void> {
        return this.requestRefresh(true);
    }

    private requestRefresh(prepareImages: boolean): Promise<void> {
        if (this.pendingRefresh) {
            if (!prepareImages || this.pendingRefreshPreparesImages) return this.pendingRefresh;
            return this.pendingRefresh.then(() => this.requestRefresh(true));
        }

        this.pendingRefreshPreparesImages = prepareImages;
        const refresh = this.refreshRegistry(prepareImages)
            .finally(() => {
                this.pendingRefresh = null;
                this.pendingRefreshPreparesImages = false;
            });
        this.pendingRefresh = refresh;
        return refresh;
    }

    private async refreshRegistry(prepareImages: boolean): Promise<void> {
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

            if (configs.length === 0) {
                // Fallback: Create default Claude agent from ENV vars if no config exists
                logger.info('No agents configured, creating default Claude agent from environment');
                await this.registerDefaultAgent(prepareImages);
                await this.captureRuntimePackageStateVersion();
                this.initialized = true;
                return;
            }

            const bundleImage = await this.ensureUnifiedAgentImage(configs, prepareImages);
            if (!bundleImage) {
                await this.captureRuntimePackageStateVersion();
                this.initialized = true;
                logger.warn(
                    this.agents.size > 0
                        ? 'Keeping existing agents because the newly configured unified image is unavailable'
                        : 'Agent registry initialized without agents because the unified agent image is unavailable',
                );
                return;
            }

            // Resolve potentially slow image work before replacing the live
            // registry, so a package/version rebuild does not interrupt tasks
            // that can still use the previous image.
            this.agents.clear();
            this.agentsByAlias.clear();
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

                    config.dockerImage = bundleImage;

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

            await this.syntheticAgents.register();

            await this.captureRuntimePackageStateVersion();
            this.initialized = true;
            logger.info({
                totalAgents: this.agents.size,
                enabledAgents: Array.from(this.agentsByAlias.keys())
            }, 'Agent registry refreshed successfully');
        } catch (error) {
            const err = error as Error;
            logger.error({ error: err.message }, 'Failed to refresh agent registry, using default agent');

            // Fallback to the default agent only after its image resolves; a
            // failed fallback leaves any previously working registry intact.
            await this.registerDefaultAgent(prepareImages);
            await this.captureRuntimePackageStateVersion();
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

    beginRoutingSession(options: BeginSyntheticRoutingOptions): SyntheticRoutingSession {
        return this.syntheticAgents.begin(options);
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

    getOperationalStatus(): AgentRegistryOperationalStatus {
        if (this.unavailableUnifiedAgentImage) {
            return {
                unifiedAgentImage: {
                    status: 'unavailable',
                    ...this.unavailableUnifiedAgentImage
                }
            };
        }
        return { unifiedAgentImage: { status: 'ready' } };
    }

    /**
     * Ensures the registry is initialized, refreshing if necessary.
     *
     * When a runtime package state change is detected on an already-initialized
     * registry, the inspect-only refresh runs in the background. The dedicated
     * runtime build worker prepares changed package images before publishing the
     * new state, so request-serving paths never start Docker builds themselves.
     */
    async ensureInitialized(): Promise<void> {
        if (!this.initialized) {
            await this.refresh();
            return;
        }

        // A background refresh clears and repopulates the registry maps. Keep
        // serving the old agents only while their images still exist; if they
        // do not, wait for the in-flight refresh instead of returning an agent
        // whose next `docker run` would attempt an invalid registry pull.
        if (this.pendingBackgroundRefresh) {
            if (this.agents.size === 0 || !(await this.registeredAgentImagesAvailable())) {
                await this.pendingBackgroundRefresh;
            }
            return;
        }

        // If an image disappears after initialization, synchronously reload the
        // inspect-only registry state so execution never reaches Docker with a
        // missing local tag. Rebuilding remains the startup/config owner's job.
        if (!(await this.registeredAgentImagesAvailable())) {
            if (!this.pendingBackgroundRefresh) {
                logger.warn('Refreshing agent registry because a registered agent image is no longer available locally');
                this.pendingBackgroundRefresh = this.refresh()
                    .finally(() => {
                        this.pendingBackgroundRefresh = null;
                    });
            }
            await this.pendingBackgroundRefresh;
            return;
        }

        const now = Date.now();
        if (now < this.runtimePackageStateCheckAfter) return;
        this.runtimePackageStateCheckAfter = now + RUNTIME_PACKAGE_STATE_CHECK_INTERVAL_MS;
        if (this.pendingBackgroundRefresh || !(await this.hasRuntimePackageStateChanged())) return;
        logger.info('Refreshing agent registry in the background because agent runtime package state changed');
        this.pendingBackgroundRefresh = this.refresh()
            .catch(error => {
                logger.error({ error: (error as Error).message }, 'Background agent registry refresh failed');
            })
            .finally(() => {
                this.pendingBackgroundRefresh = null;
            });
    }

    private async registeredAgentImagesAvailable(): Promise<boolean> {
        const images = [...new Set([...this.agents.values()]
            .map(agent => agent.config.dockerImage)
            .filter(Boolean))];
        if (images.length === 0) return true;

        try {
            const result = await executeDockerCommand('docker', [
                'image', 'inspect', '--format', '{{.Id}}', ...images
            ], { timeout: 10000 });
            return result.exitCode === 0;
        } catch (error) {
            logger.warn({ images, error: (error as Error).message }, 'Could not verify registered agent Docker images');
            return false;
        }
    }

    /**
     * Resolves once any in-flight background refresh has completed.
     * Primarily for shutdown paths and tests that need a settled registry.
     */
    async waitForPendingRefresh(): Promise<void> {
        await this.pendingBackgroundRefresh;
    }

    private async captureRuntimePackageStateVersion(): Promise<void> {
        try {
            this.runtimePackagesUpdatedAt = (await loadAgentRuntimePackageState()).updatedAt;
            this.runtimePackageStateUnavailable = false;
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Could not capture agent runtime package state version');
            this.runtimePackagesUpdatedAt = undefined;
            this.runtimePackageStateUnavailable = true;
        }
    }

    private async hasRuntimePackageStateChanged(): Promise<boolean> {
        if (this.runtimePackagesUpdatedAt === undefined && !this.runtimePackageStateUnavailable) return true;
        try {
            const state = await loadAgentRuntimePackageState();
            this.runtimePackageStateUnavailable = false;
            return state.updatedAt !== this.runtimePackagesUpdatedAt;
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Could not check agent runtime package state version');
            this.runtimePackageStateUnavailable = true;
            return false;
        }
    }

    private async ensureUnifiedAgentImage(configs: AgentConfig[], prepareImages: boolean): Promise<string | null> {
        const result = await resolveUnifiedAgentImage(configs, prepareImages);
        if (!result.image) {
            const error = result.error || 'Unified agent image is unavailable';
            logger.error({ error, imageTag: result.imageTag }, 'Failed to resolve unified agent image');
            this.recordUnavailableUnifiedAgentImage(result.imageTag, error);
            return null;
        }
        this.clearUnifiedAgentImageRetry();
        this.unavailableUnifiedAgentImage = null;
        return result.image;
    }

    /**
     * A consumer can initialize while the worker is still preparing the image.
     * Poll the local image state with one shared timer so it becomes ready after
     * startup completes; refresh() is inspect-only and cannot launch a build.
     */
    private scheduleUnifiedAgentImageRetry(): void {
        if (this.unifiedAgentImageRetryTimer) return;
        this.unifiedAgentImageRetryTimer = setTimeout(() => {
            this.unifiedAgentImageRetryTimer = null;
            if (!this.initialized || !this.unavailableUnifiedAgentImage || this.pendingBackgroundRefresh) return;

            const refresh = this.refresh();
            this.pendingBackgroundRefresh = refresh;
            void refresh
                .catch(error => {
                    logger.error(
                        { error: (error as Error).message },
                        'Automatic unified agent image recovery refresh failed',
                    );
                })
                .finally(() => {
                    if (this.pendingBackgroundRefresh === refresh) this.pendingBackgroundRefresh = null;
                });
        }, UNIFIED_AGENT_IMAGE_RETRY_INTERVAL_MS);
        this.unifiedAgentImageRetryTimer.unref?.();
    }

    private clearUnifiedAgentImageRetry(): void {
        if (!this.unifiedAgentImageRetryTimer) return;
        clearTimeout(this.unifiedAgentImageRetryTimer);
        this.unifiedAgentImageRetryTimer = null;
    }

    /**
     * Creates an agent instance from configuration.
     * This is the factory method that handles different agent types.
     */
    createAgentFromConfig(config: AgentConfig): Agent {
        return createAgentFromConfig(config);
    }

    /**
     * Registers a default Claude agent using environment variables.
     * This is the fallback when no agents are configured.
     */
    private async registerDefaultAgent(prepareImages: boolean): Promise<void> {
        const result = await resolveDefaultAgentConfig(prepareImages);
        if (!result.config) {
            const error = result.error || 'Default agent image is unavailable';
            this.recordUnavailableUnifiedAgentImage(result.imageTag, error);
            logger.error({ dockerImage: result.imageTag, error }, 'Failed to resolve default Claude agent image');
            return;
        }

        this.clearUnifiedAgentImageRetry();
        this.unavailableUnifiedAgentImage = null;
        this.agents.clear();
        this.agentsByAlias.clear();
        const agent = new ClaudeAgent(result.config);
        this.agents.set(result.config.id, agent);
        this.agentsByAlias.set(result.config.alias, agent);

        await this.syntheticAgents.register();

        logger.info({
            agentId: result.config.id,
            agentAlias: result.config.alias,
            dockerImage: result.config.dockerImage
        }, 'Default Claude agent registered');
    }

    private recordUnavailableUnifiedAgentImage(imageTag: string | undefined, error: string): void {
        this.unavailableUnifiedAgentImage = {
            imageTag,
            error,
            recordedAt: new Date().toISOString(),
        };
        this.scheduleUnifiedAgentImageRetry();
    }

    /**
     * Clean up resources and connections.
     * Should be called during shutdown or test cleanup.
     */
    async destroy(): Promise<void> {
        try {
            this.clearUnifiedAgentImageRetry();
            // Clear agents and state
            this.agents.clear();
            this.agentsByAlias.clear();
            this.syntheticAgents.clear();
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
