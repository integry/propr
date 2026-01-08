import { test, mock, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';

// Set test environment before any imports
process.env.NODE_ENV = 'test';

// Import types only first
import type { AgentConfig, Agent } from '@gitfix/core';

// Lazy import to control when module initialization happens
let AgentRegistry: typeof import('@gitfix/core').AgentRegistry;
let ClaudeAgent: typeof import('@gitfix/core').ClaudeAgent;

// Initialize modules before tests
test('AgentRegistry', async (t) => {
    // Dynamic import to control initialization timing
    const coreModule = await import('@gitfix/core');
    AgentRegistry = coreModule.AgentRegistry;
    ClaudeAgent = coreModule.ClaudeAgent;

    beforeEach(() => {
        // Reset the singleton for each test by accessing the private instance
        // @ts-expect-error - accessing private static for testing
        AgentRegistry.instance = undefined;
    });

    await t.test('should be a singleton', () => {
        const registry1 = AgentRegistry.getInstance();
        const registry2 = AgentRegistry.getInstance();
        assert.strictEqual(registry1, registry2, 'Should return the same instance');
    });

    await t.test('should create default agent when no configs exist', async () => {
        const registry = AgentRegistry.getInstance();

        // Since we can't easily mock the configManager, we test the default behavior
        // The refresh() method will fall back to default agent on errors
        await registry.refresh();

        const defaultAgent = registry.getDefaultAgent();
        assert.ok(defaultAgent, 'Default agent should exist');
        assert.strictEqual(defaultAgent.config.alias, 'default', 'Default agent should have alias "default"');
        assert.strictEqual(defaultAgent.config.type, 'claude', 'Default agent should be claude type');
    });

    await t.test('should get agent by alias', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const agent = registry.getAgentByAlias('default');
        assert.ok(agent, 'Should find agent by alias');
        assert.strictEqual(agent.config.alias, 'default');
    });

    await t.test('should return undefined for non-existent alias', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const agent = registry.getAgentByAlias('non-existent');
        assert.strictEqual(agent, undefined, 'Should return undefined for non-existent alias');
    });

    await t.test('should return all agents', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const agents = registry.getAllAgents();
        assert.ok(Array.isArray(agents), 'Should return an array');
        assert.ok(agents.length >= 1, 'Should have at least one agent');
    });

    await t.test('should report initialization status', async () => {
        const registry = AgentRegistry.getInstance();

        // New instance should not be initialized
        assert.strictEqual(registry.isInitialized(), false, 'New registry should not be initialized');

        await registry.refresh();

        assert.strictEqual(registry.isInitialized(), true, 'Registry should be initialized after refresh');
    });

    await t.test('ensureInitialized should call refresh if not initialized', async () => {
        const registry = AgentRegistry.getInstance();

        assert.strictEqual(registry.isInitialized(), false);

        await registry.ensureInitialized();

        assert.strictEqual(registry.isInitialized(), true);
    });

    await t.test('ensureInitialized should not refresh if already initialized', async () => {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();

        const agentsBefore = registry.getAllAgents().length;
        await registry.ensureInitialized();
        const agentsAfter = registry.getAllAgents().length;

        assert.strictEqual(agentsBefore, agentsAfter, 'Should not change agents if already initialized');
    });
});

test('AgentConfig Validation', async (t) => {
    await t.test('valid agent config should have required fields', () => {
        const validConfig: AgentConfig = {
            id: 'test-uuid-1234',
            type: 'claude',
            alias: 'test-agent',
            enabled: true,
            dockerImage: 'claude-code-processor:latest',
            configPath: '/root/.claude',
            supportedModels: ['claude-opus-4-5', 'claude-sonnet-4-5']
        };

        assert.ok(validConfig.id, 'Should have id');
        assert.ok(['claude', 'codex', 'gemini'].includes(validConfig.type), 'Type should be valid');
        assert.ok(validConfig.alias, 'Should have alias');
        assert.strictEqual(typeof validConfig.enabled, 'boolean', 'Enabled should be boolean');
        assert.ok(validConfig.dockerImage, 'Should have dockerImage');
        assert.ok(validConfig.configPath, 'Should have configPath');
        assert.ok(Array.isArray(validConfig.supportedModels), 'supportedModels should be array');
    });

    await t.test('alias validation regex pattern', () => {
        const validAliases = ['claude-prod', 'codex-beta', 'agent1', 'my-test-agent'];
        const invalidAliases = ['Claude-Prod', 'agent_1', 'my agent', 'agent.1'];

        const aliasRegex = /^[a-z0-9-]+$/;

        for (const alias of validAliases) {
            assert.ok(aliasRegex.test(alias), `"${alias}" should be valid`);
        }

        for (const alias of invalidAliases) {
            assert.ok(!aliasRegex.test(alias), `"${alias}" should be invalid`);
        }
    });
});

test('ClaudeAgent', async (t) => {
    const testConfig: AgentConfig = {
        id: 'test-claude-agent',
        type: 'claude',
        alias: 'test',
        enabled: true,
        dockerImage: 'claude-code-processor:test',
        configPath: '/tmp/test-claude',
        supportedModels: ['claude-opus-4-5'],
        defaultModel: 'claude-opus-4-5',
        envVars: {
            'TEST_VAR': 'test-value'
        }
    };

    await t.test('should be instantiable with config', () => {
        const agent = new ClaudeAgent(testConfig);
        assert.ok(agent, 'Agent should be created');
        assert.strictEqual(agent.config.id, testConfig.id);
        assert.strictEqual(agent.config.alias, testConfig.alias);
        assert.strictEqual(agent.config.dockerImage, testConfig.dockerImage);
    });

    await t.test('should expose config as readonly', () => {
        const agent = new ClaudeAgent(testConfig);
        assert.deepStrictEqual(agent.config, testConfig);
    });

    await t.test('should have executeTask method', () => {
        const agent = new ClaudeAgent(testConfig);
        assert.strictEqual(typeof agent.executeTask, 'function');
    });

    await t.test('should have analyze method', () => {
        const agent = new ClaudeAgent(testConfig);
        assert.strictEqual(typeof agent.analyze, 'function');
    });

    await t.test('should have healthCheck method', () => {
        const agent = new ClaudeAgent(testConfig);
        assert.strictEqual(typeof agent.healthCheck, 'function');
    });
});

test('Agent Interface Contract', async (t) => {
    await t.test('ClaudeAgent implements Agent interface', () => {
        const config: AgentConfig = {
            id: 'interface-test',
            type: 'claude',
            alias: 'interface-test',
            enabled: true,
            dockerImage: 'test:latest',
            configPath: '/tmp/test',
            supportedModels: ['model-1']
        };

        const agent = new ClaudeAgent(config);

        // Verify interface compliance
        assert.ok('config' in agent, 'Should have config property');
        assert.ok('executeTask' in agent, 'Should have executeTask method');
        assert.ok('analyze' in agent, 'Should have analyze method');
        assert.ok('healthCheck' in agent, 'Should have healthCheck method');
    });
});

// Cleanup after all tests
after(async () => {
    try {
        // Reset and cleanup the AgentRegistry instance
        if (AgentRegistry) {
            await AgentRegistry.resetInstance();
        }

        // Also close any remaining connections
        try {
            const {
                closeConnection,
                shutdownQueue,
                hasQueueResources,
                closeAnalysisRedis,
                hasAnalysisRedisResources,
                closeStateManager
            } = await import('@gitfix/core');

            await closeConnection();

            // Only shutdown queue if resources were created
            if (hasQueueResources()) {
                await shutdownQueue();
            }

            // Close analysis service Redis if it was created
            if (hasAnalysisRedisResources()) {
                await closeAnalysisRedis();
            }

            // Close state manager Redis
            await closeStateManager();
        } catch {
            // Connections may already be closed
        }

        // Brief delay for cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
        console.error('Error during test cleanup:', error);
    }
});
