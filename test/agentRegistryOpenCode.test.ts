import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

process.env.NODE_ENV = 'test';
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-agent-registry-'));
process.env.DATA_DIR = testDataDir;

const opencodeConfig: AgentConfig = {
    id: 'opencode-1',
    type: 'opencode',
    alias: 'opencode',
    enabled: true,
    dockerImage: 'propr/agent:latest',
    configPath: '~/.config/opencode',
    supportedModels: ['opencode-big-pickle'],
    defaultModel: 'opencode-big-pickle'
};

let AgentRegistry: typeof import('../packages/core/src/agents/AgentRegistry.js').AgentRegistry;
let OpenCodeAgent: typeof import('../packages/core/src/agents/impl/OpenCodeAgent.js').OpenCodeAgent;
let ClaudeAgent: typeof import('../packages/core/src/agents/impl/ClaudeAgent.js').ClaudeAgent;
let runMigrations: typeof import('../packages/core/src/db/connection.js').runMigrations;
let closeConnection: typeof import('../packages/core/src/db/connection.js').closeConnection;
let saveAgents: typeof import('../packages/core/src/config/configManager.js').saveAgents;
let loadAgents: typeof import('../packages/core/src/config/configManager.js').loadAgents;
let saveSettings: typeof import('../packages/core/src/config/configManager.js').saveSettings;
let saveAgentRuntimePackageState: typeof import('../packages/core/src/agents/runtime/agentRuntimePackages.js').saveAgentRuntimePackageState;
let getUnifiedAgentImageRetryDelay: typeof import('../packages/core/src/agents/AgentRegistry.js').getUnifiedAgentImageRetryDelay;
let UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS: typeof import('../packages/core/src/agents/AgentRegistry.js').UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS;

before(async () => {
    ({ AgentRegistry } = await import('../packages/core/src/agents/AgentRegistry.js'));
    ({ OpenCodeAgent } = await import('../packages/core/src/agents/impl/OpenCodeAgent.js'));
    ({ ClaudeAgent } = await import('../packages/core/src/agents/impl/ClaudeAgent.js'));
    ({ runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js'));
    ({ saveAgents, loadAgents, saveSettings } = await import('../packages/core/src/config/configManager.js'));
    ({ saveAgentRuntimePackageState } = await import('../packages/core/src/agents/runtime/agentRuntimePackages.js'));
    ({ getUnifiedAgentImageRetryDelay, UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS } = await import('../packages/core/src/agents/AgentRegistry.js'));
    await runMigrations();
});

beforeEach(async () => {
    (AgentRegistry as unknown as { instance?: unknown }).instance = undefined;
    await saveAgents([opencodeConfig]);
    await saveSettings({ default_agent_alias: null });
    AgentRegistry.getInstance().setImagePreparationOwner(true);
});

after(async () => {
    (AgentRegistry as unknown as { instance?: unknown }).instance = undefined;
    await closeConnection();
    fs.rmSync(testDataDir, { recursive: true, force: true });
});

function skipImageChecks(registry: InstanceType<typeof AgentRegistry>): void {
    (registry as unknown as { ensureUnifiedAgentImage: () => Promise<string> }).ensureUnifiedAgentImage = async () => 'propr/agent:latest';
    (registry as unknown as { registeredAgentImagesAvailable: () => Promise<boolean> }).registeredAgentImagesAvailable = async () => true;
}

function failImageChecks(registry: InstanceType<typeof AgentRegistry>): void {
    (registry as unknown as { ensureUnifiedAgentImage: () => Promise<string | null> }).ensureUnifiedAgentImage = async () => null;
}

function stubDefaultClaudeRegistration(registry: InstanceType<typeof AgentRegistry>): void {
    (registry as unknown as { registerDefaultAgent: () => Promise<void> }).registerDefaultAgent = async function registerDefaultAgent(this: {
        agents: Map<string, unknown>;
        agentsByAlias: Map<string, unknown>;
    }) {
        const defaultConfig: AgentConfig = {
            id: 'default-claude-agent',
            type: 'claude',
            alias: 'default',
            enabled: true,
            dockerImage: 'propr/agent:latest',
            configPath: '~/.claude',
            supportedModels: ['claude-sonnet-4-6'],
            defaultModel: undefined
        };
        const agent = new ClaudeAgent(defaultConfig);
        this.agents.set(defaultConfig.id, agent);
        this.agentsByAlias.set(defaultConfig.alias, agent);
    };
}

test('AgentRegistry registers enabled OpenCode configs by alias', async () => {
    const registry = AgentRegistry.getInstance();
    skipImageChecks(registry);

    await registry.refresh();

    const agent = registry.getAgentByAlias('opencode');
    assert.ok(agent instanceof OpenCodeAgent);
    assert.strictEqual(agent.config.type, 'opencode');
    assert.strictEqual(agent.config.alias, 'opencode');
    assert.ok(
        registry.getAllAgents().some(registeredAgent => registeredAgent instanceof OpenCodeAgent),
        'AgentRegistry factory should construct an OpenCodeAgent from an OpenCode config'
    );
});

test('AgentRegistry keeps explicit config refresh inspect-only', async () => {
    const registry = AgentRegistry.getInstance();
    const preparationModes: boolean[] = [];
    (registry as unknown as {
        ensureUnifiedAgentImage: (_configs: AgentConfig[], prepareImages: boolean) => Promise<string>;
        registeredAgentImagesAvailable: () => Promise<boolean>;
    }).ensureUnifiedAgentImage = async (_configs, prepareImages) => {
        preparationModes.push(prepareImages);
        return 'propr/agent:prepared';
    };
    (registry as unknown as {
        registeredAgentImagesAvailable: () => Promise<boolean>;
    }).registeredAgentImagesAvailable = async () => true;

    await registry.refresh();
    await registry.prepareImagesAndRefresh();

    assert.deepStrictEqual(preparationModes, [false, true]);
});

test('AgentRegistry treats an explicitly all-disabled configuration as no work without preparing an image', async () => {
    await saveAgents([{ ...opencodeConfig, enabled: false }]);
    const registry = AgentRegistry.getInstance();
    let imagePreparationAttempts = 0;
    (registry as unknown as {
        ensureUnifiedAgentImage: () => Promise<string>;
    }).ensureUnifiedAgentImage = async () => {
        imagePreparationAttempts += 1;
        throw new Error('disabled agents must not require Docker');
    };

    await registry.prepareImagesAndRefresh();

    assert.strictEqual(imagePreparationAttempts, 0);
    assert.strictEqual(registry.isInitialized(), true);
    assert.deepStrictEqual(registry.getAllAgents(), []);
    assert.deepStrictEqual(registry.getOperationalStatus(), {
        unifiedAgentImage: { status: 'ready' }
    });
});

test('AgentRegistry prepares an execution image on first-use initialization', async () => {
    const registry = AgentRegistry.getInstance();
    const preparationModes: boolean[] = [];
    (registry as unknown as {
        ensureUnifiedAgentImage: (_configs: AgentConfig[], prepareImages: boolean) => Promise<string>;
        registeredAgentImagesAvailable: () => Promise<boolean>;
    }).ensureUnifiedAgentImage = async (_configs, prepareImages) => {
        preparationModes.push(prepareImages);
        return 'propr/agent:prepared';
    };
    (registry as unknown as {
        registeredAgentImagesAvailable: () => Promise<boolean>;
    }).registeredAgentImagesAvailable = async () => true;

    await registry.ensureInitialized();
    await registry.ensureInitialized();

    assert.deepStrictEqual(preparationModes, [true]);
    assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:prepared');
});

test('AgentRegistry coalesces concurrent refreshes in one process', async () => {
    const registry = AgentRegistry.getInstance();
    let refreshes = 0;
    (registry as unknown as {
        ensureUnifiedAgentImage: () => Promise<string>;
    }).ensureUnifiedAgentImage = async () => {
        refreshes += 1;
        await new Promise<void>(resolve => setImmediate(resolve));
        return 'propr/agent:prepared';
    };

    await Promise.all([
        registry.refresh(),
        registry.refresh(),
        registry.refresh(),
    ]);

    assert.strictEqual(refreshes, 1);
});

test('AgentRegistry degrades without throwing when unified image is unavailable', async () => {
    const registry = AgentRegistry.getInstance();
    failImageChecks(registry);

    await registry.refresh();

    assert.strictEqual(registry.isInitialized(), true);
    assert.deepStrictEqual(registry.getAllAgents(), []);
});

test('AgentRegistry keeps working agents while a replacement image is unavailable', async () => {
    const registry = AgentRegistry.getInstance();
    (registry as unknown as {
        ensureUnifiedAgentImage: () => Promise<string | null>;
    }).ensureUnifiedAgentImage = async () => 'propr/agent:working';

    await registry.refresh();
    (registry as unknown as {
        ensureUnifiedAgentImage: () => Promise<string | null>;
    }).ensureUnifiedAgentImage = async () => null;
    await registry.prepareImagesAndRefresh();

    assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:working');
});

test('AgentRegistry exposes unified image degraded status', async () => {
    const registry = AgentRegistry.getInstance();
    (registry as unknown as { ensureUnifiedAgentImage: () => Promise<string | null> }).ensureUnifiedAgentImage = async function fail(this: {
        unavailableUnifiedAgentImage: { imageTag: string; error: string; recordedAt: string };
    }) {
        this.unavailableUnifiedAgentImage = {
            imageTag: 'propr/agent:bundle-test',
            error: 'pull failed',
            recordedAt: '2026-07-17T00:00:00.000Z'
        };
        return null;
    };

    await registry.refresh();

    assert.deepStrictEqual(registry.getOperationalStatus(), {
        unifiedAgentImage: {
            status: 'unavailable',
            imageTag: 'propr/agent:bundle-test',
            error: 'pull failed',
            recordedAt: '2026-07-17T00:00:00.000Z'
        }
    });
});

test('AgentRegistry uses bounded exponential backoff with jitter', () => {
    assert.strictEqual(getUnifiedAgentImageRetryDelay(1, () => 0.5), 5_000);
    assert.strictEqual(getUnifiedAgentImageRetryDelay(2, () => 0.5), 10_000);
    assert.strictEqual(getUnifiedAgentImageRetryDelay(3, () => 0.5), 20_000);
    assert.strictEqual(getUnifiedAgentImageRetryDelay(4, () => 0.5), 40_000);
    assert.strictEqual(getUnifiedAgentImageRetryDelay(5, () => 0.5), 80_000);
    assert.strictEqual(getUnifiedAgentImageRetryDelay(50, () => 0.5), 5 * 60_000);
});

test('AgentRegistry API recovery requests one worker-owned preparation', async () => {
    const registry = AgentRegistry.getInstance();
    registry.setImagePreparationOwner(false);
    const preparationModes: boolean[] = [];
    let recoveryRequests = 0;
    let recovery: Promise<void> | undefined;
    const internal = registry as unknown as {
        ensureUnifiedAgentImage: (_configs: AgentConfig[], prepareImages: boolean) => Promise<string | null>;
        startWorkerOwnedImageRecovery: () => Promise<void>;
        unavailableUnifiedAgentImage: { imageTag: string; error: string; recordedAt: string } | null;
    };
    internal.ensureUnifiedAgentImage = async (_configs, prepareImages) => {
        preparationModes.push(prepareImages);
        internal.unavailableUnifiedAgentImage = {
            imageTag: 'propr/agent:bundle-retry',
            error: 'temporary download failure',
            recordedAt: '2026-08-08T20:00:00.000Z'
        };
        return null;
    };
    internal.startWorkerOwnedImageRecovery = () => {
        recovery ??= Promise.resolve().then(() => {
            recoveryRequests += 1;
            internal.unavailableUnifiedAgentImage = null;
        });
        return recovery;
    };

    await Promise.all([registry.ensureInitialized(), registry.ensureInitialized()]);

    assert.deepStrictEqual(preparationModes, [false]);
    assert.strictEqual(recoveryRequests, 1);
});

test('AgentRegistry opens a circuit after bounded transient failures', () => {
    const registry = AgentRegistry.getInstance();
    registry.setImagePreparationOwner(false);
    const internal = registry as unknown as {
        recordUnavailableUnifiedAgentImage: (imageTag: string, error: string) => void;
        clearUnifiedAgentImageRetry: () => void;
    };

    internal.recordUnavailableUnifiedAgentImage('propr/agent:bundle-retry', 'temporary download failure');
    assert.ok(registry.getOperationalStatus().unifiedAgentImage.nextRetryAt);
    for (let attempt = 1; attempt < UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS; attempt += 1) {
        internal.recordUnavailableUnifiedAgentImage('propr/agent:bundle-retry', 'temporary download failure');
    }
    internal.clearUnifiedAgentImageRetry();

    const status = registry.getOperationalStatus().unifiedAgentImage;
    assert.strictEqual(status.status, 'unavailable');
    assert.strictEqual(status.retryCount, UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS);
    assert.strictEqual(status.circuitBreakerOpen, true);
    assert.strictEqual(status.operatorActionRequired, undefined);
});

test('AgentRegistry halts recovery immediately for ENOSPC', () => {
    const registry = AgentRegistry.getInstance();
    const internal = registry as unknown as {
        recordUnavailableUnifiedAgentImage: (imageTag: string, error: string) => void;
    };

    internal.recordUnavailableUnifiedAgentImage('propr/agent:bundle-disk-full', 'docker build failed: no space left on device');

    const status = registry.getOperationalStatus().unifiedAgentImage;
    assert.strictEqual(status.circuitBreakerOpen, true);
    assert.strictEqual(status.operatorActionRequired, true);
    assert.match(status.error || '', /no space left on device/);
});

test('AgentRegistry clears failure state after successful preparation', () => {
    const registry = AgentRegistry.getInstance();
    const internal = registry as unknown as {
        recordUnavailableUnifiedAgentImage: (imageTag: string, error: string) => void;
        markUnifiedAgentImageReady: (imageTag: string) => string;
    };

    internal.recordUnavailableUnifiedAgentImage('propr/agent:bundle-recovered', 'temporary download failure');
    assert.strictEqual(internal.markUnifiedAgentImageReady('propr/agent:bundle-recovered'), 'propr/agent:bundle-recovered');
    assert.deepStrictEqual(registry.getOperationalStatus(), {
        unifiedAgentImage: { status: 'ready' }
    });
});

test('AgentRegistry refreshes when runtime package state changes', async () => {
    const registry = AgentRegistry.getInstance();
    let image = 'propr/agent:first';
    (registry as unknown as { ensureUnifiedAgentImage: () => Promise<string> }).ensureUnifiedAgentImage = async () => image;
    (registry as unknown as { registeredAgentImagesAvailable: () => Promise<boolean> }).registeredAgentImagesAvailable = async () => true;

    await registry.refresh();
    assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:first');

    image = 'propr/agent:second';
    await saveAgentRuntimePackageState({
        installationId: 'test-runtime',
        packages: [],
        activePackages: [],
        status: 'disabled',
        images: {},
        updatedAt: '2026-07-17T15:45:00.000Z'
    });

    await registry.ensureInitialized();
    await registry.waitForPendingRefresh();

    assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:second');
});

test('AgentRegistry refreshes after runtime package state version capture fails', async () => {
    const registry = AgentRegistry.getInstance();
    let image = 'propr/agent:first';
    (registry as unknown as { ensureUnifiedAgentImage: () => Promise<string> }).ensureUnifiedAgentImage = async () => image;
    (registry as unknown as { registeredAgentImagesAvailable: () => Promise<boolean> }).registeredAgentImagesAvailable = async () => true;

    await registry.refresh();
    assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:first');

    image = 'propr/agent:second';
    (registry as unknown as { runtimePackagesUpdatedAt?: string }).runtimePackagesUpdatedAt = undefined;
    await registry.ensureInitialized();
    await registry.waitForPendingRefresh();

    assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:second');
});

test('AgentRegistry throttles runtime package state checks on repeated initialization guards', async () => {
    const registry = AgentRegistry.getInstance();
    skipImageChecks(registry);

    await registry.refresh();

    let checks = 0;
    (registry as unknown as { hasRuntimePackageStateChanged: () => Promise<boolean> }).hasRuntimePackageStateChanged = async () => {
        checks += 1;
        return false;
    };

    await registry.ensureInitialized();
    await registry.ensureInitialized();

    assert.strictEqual(checks, 1);
});

test('AgentRegistry refreshes before use when its registered image was removed', async () => {
    const registry = AgentRegistry.getInstance();
    let image = 'propr/agent:first';
    const preparationModes: boolean[] = [];
    (registry as unknown as {
        ensureUnifiedAgentImage: (_configs: AgentConfig[], prepareImages: boolean) => Promise<string>;
    }).ensureUnifiedAgentImage = async (_configs, prepareImages) => {
        preparationModes.push(prepareImages);
        return image;
    };

    await registry.refresh();
    assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:first');

    image = 'propr/agent:second';
    let availabilityChecks = 0;
    (registry as unknown as { registeredAgentImagesAvailable: () => Promise<boolean> }).registeredAgentImagesAvailable = async () => {
        availabilityChecks += 1;
        return false;
    };

    await registry.ensureInitialized();

    assert.strictEqual(availabilityChecks, 1);
    assert.deepStrictEqual(preparationModes, [false, true]);
    assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:second');
});

test('AgentRegistry shares one recovery refresh across concurrent callers', async () => {
    const registry = AgentRegistry.getInstance();
    let refreshes = 0;
    (registry as unknown as { ensureUnifiedAgentImage: () => Promise<string> }).ensureUnifiedAgentImage = async () => {
        refreshes += 1;
        return refreshes === 1 ? 'propr/agent:first' : 'propr/agent:second';
    };

    await registry.refresh();
    (registry as unknown as { registeredAgentImagesAvailable: () => Promise<boolean> }).registeredAgentImagesAvailable = async () => false;

    await Promise.all([
        registry.ensureInitialized(),
        registry.ensureInitialized()
    ]);

    assert.strictEqual(refreshes, 2, 'initialization plus exactly one shared recovery refresh');
    assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:second');
});

test('AgentRegistry prefixes dynamic OpenCode provider models during migration', async () => {
    await saveAgents([{
        ...opencodeConfig,
        supportedModels: ['openai/gpt-5.5'],
        defaultModel: 'openai/gpt-5.5'
    }]);

    const registry = AgentRegistry.getInstance();
    skipImageChecks(registry);

    await registry.refresh();

    const [savedAgent] = await loadAgents();
    assert.ok(savedAgent.supportedModels.includes('opencode-openai/gpt-5.5'));
    assert.strictEqual(savedAgent.defaultModel, 'opencode-openai/gpt-5.5');
});

test('AgentRegistry keeps default Claude fallback when no agents are configured', async () => {
    await saveAgents([]);
    const registry = AgentRegistry.getInstance();
    skipImageChecks(registry);
    stubDefaultClaudeRegistration(registry);

    await registry.refresh();

    const defaultAgent = registry.getDefaultAgent();
    assert.ok(defaultAgent);
    assert.strictEqual(defaultAgent.config.type, 'claude');
    assert.strictEqual(defaultAgent.config.alias, 'default');
});
