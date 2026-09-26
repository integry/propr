import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

// Keep the logging transport worker out of tests that replace the clock and
// timers. Its asynchronous flush can otherwise keep this process alive after
// every registry assertion and database cleanup have completed.
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: {
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
    },
});

const enqueuePreparation = mock.fn(async (_imageTag: string): Promise<void> => {});
await mock.module('../packages/core/src/agents/agentImagePreparationQueue.js', {
    namedExports: {
        enqueueAgentImagePreparation: enqueuePreparation,
        closeAgentImagePreparationQueue: async () => {},
    },
});

const dockerCommand = mock.fn(async (_command: string, _args: string[]): Promise<import('../packages/core/src/claude/docker/dockerExecutor.js').ExecutionResult> => {
    throw new Error('Unexpected Docker command');
});
const unexpectedBuild = mock.fn(async () => { throw new Error('Consumers must not build images'); });
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        executeDockerCommand: dockerCommand,
        agentDockerImageExists: async () => true,
        ensureAgentBundleImage: unexpectedBuild,
        ensureAgentDockerImage: unexpectedBuild,
        getDockerRootDir: async () => '/docker/storage',
    },
});

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
let UNIFIED_AGENT_IMAGE_CIRCUIT_COOLDOWN_MS: typeof import('../packages/core/src/agents/AgentRegistry.js').UNIFIED_AGENT_IMAGE_CIRCUIT_COOLDOWN_MS;

before(async () => {
    ({ AgentRegistry } = await import('../packages/core/src/agents/AgentRegistry.js'));
    ({ OpenCodeAgent } = await import('../packages/core/src/agents/impl/OpenCodeAgent.js'));
    ({ ClaudeAgent } = await import('../packages/core/src/agents/impl/ClaudeAgent.js'));
    ({ runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js'));
    ({ saveAgents, loadAgents, saveSettings } = await import('../packages/core/src/config/configManager.js'));
    ({ saveAgentRuntimePackageState } = await import('../packages/core/src/agents/runtime/agentRuntimePackages.js'));
    ({
        getUnifiedAgentImageRetryDelay,
        UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS,
        UNIFIED_AGENT_IMAGE_CIRCUIT_COOLDOWN_MS,
    } = await import('../packages/core/src/agents/AgentRegistry.js'));
    await runMigrations();
});

beforeEach(async () => {
    enqueuePreparation.mock.resetCalls();
    enqueuePreparation.mock.mockImplementation(async () => {});
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

for (const diskPressure of [false, true]) {
    test(`AgentRegistry recovers an empty worker after enabling its first agent (diskPressure=${diskPressure})`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
        t.mock.method(Math, 'random', () => 0.5);
        await saveAgents([{ ...opencodeConfig, enabled: false }]);
        const registry = AgentRegistry.getInstance();
        const internal = registry as unknown as {
            ensureUnifiedAgentImage: (_configs: AgentConfig[], prepareImages: boolean) => Promise<string | null>;
            recordUnavailableUnifiedAgentImage: (imageTag: string, error: string) => void;
            markUnifiedAgentImageReady: (imageTag: string) => string;
            unifiedAgentImageRetryTimer: NodeJS.Timeout | null;
        };
        const preparationModes: boolean[] = [];
        internal.ensureUnifiedAgentImage = async (_configs, prepareImages) => {
            preparationModes.push(prepareImages);
            if (preparationModes.length === 1) {
                internal.recordUnavailableUnifiedAgentImage('propr/agent:first', diskPressure ? 'ENOSPC' : 'temporary failure');
                return null;
            }
            return internal.markUnifiedAgentImageReady('propr/agent:first');
        };
        await registry.ensureInitialized();
        await registry.ensureInitialized();
        assert.deepStrictEqual(preparationModes, []);
        await saveAgents([opencodeConfig]);
        await registry.prepareImagesAndRefresh();
        assert.deepStrictEqual(registry.getAllAgents(), []);
        assert.strictEqual(!!internal.unifiedAgentImageRetryTimer, !diskPressure);

        await registry.ensureInitialized();
        t.mock.timers.tick(4_999);
        await registry.ensureInitialized();
        assert.deepStrictEqual(preparationModes, [true], 'initialization respects the retry deadline');
        t.mock.timers.tick(1);
        await registry.ensureInitialized();
        assert.deepStrictEqual(preparationModes, diskPressure ? [true] : [true, true]);
        assert.strictEqual(enqueuePreparation.mock.callCount(), 0);
        if (diskPressure) {
            assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.circuitBreakerOpen, true);
            assert.deepStrictEqual(registry.getAllAgents(), []);
        } else {
            assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.status, 'ready');
            assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:first');
        }
    });
}

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

for (const failurePath of ['enqueue', 'refresh'] as const) {
    test(`AgentRegistry re-arms retries after ${failurePath} failures until the circuit opens`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
        t.mock.method(Math, 'random', () => 0.5);
        const registry = AgentRegistry.getInstance();
        registry.setImagePreparationOwner(false);
        const internal = registry as unknown as {
            startWorkerOwnedImageRecovery: () => Promise<void>;
            recordUnavailableUnifiedAgentImage: (imageTag: string, error: string) => void;
            ensureUnifiedAgentImage: () => Promise<string | null>;
            pendingBackgroundRefresh: Promise<void> | null;
            unifiedAgentImageRetryTimer: NodeJS.Timeout | null;
            clearUnifiedAgentImageRetry: () => void;
        };
        const imageTag = 'propr/agent:bundle-retry';
        const error = 'temporary download failure';
        if (failurePath === 'enqueue') {
            enqueuePreparation.mock.mockImplementation(async () => { throw new Error(error); });
        } else {
            internal.ensureUnifiedAgentImage = async () => {
                internal.recordUnavailableUnifiedAgentImage(imageTag, error);
                return null;
            };
        }
        internal.recordUnavailableUnifiedAgentImage(imageTag, error);
        try {
            t.mock.timers.tick(getUnifiedAgentImageRetryDelay(1, () => 0.5));
            const recovery = internal.pendingBackgroundRefresh;
            assert.strictEqual(internal.startWorkerOwnedImageRecovery(), recovery);
            await recovery;
            for (let retryCount = 2; retryCount < UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS; retryCount += 1) {
                const status = registry.getOperationalStatus().unifiedAgentImage;
                const delay = getUnifiedAgentImageRetryDelay(retryCount, () => 0.5);
                assert.strictEqual(status.retryCount, retryCount);
                assert.strictEqual(status.nextRetryAt, new Date(Date.now() + delay).toISOString());
                assert.ok(internal.unifiedAgentImageRetryTimer);
                assert.strictEqual(internal.pendingBackgroundRefresh, null);
                assert.strictEqual(enqueuePreparation.mock.callCount(), retryCount - 1);
                t.mock.timers.tick(delay);
                await internal.pendingBackgroundRefresh;
            }
            const status = registry.getOperationalStatus().unifiedAgentImage;
            assert.strictEqual(status.retryCount, UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS);
            assert.strictEqual(status.circuitBreakerOpen, true);
            assert.strictEqual(status.nextRetryAt, undefined);
            assert.strictEqual(status.circuitOpenedAt, new Date().toISOString());
            assert.strictEqual(enqueuePreparation.mock.callCount(), UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS - 1);
            // A circuit opened by transient failures is bounded: its cooldown
            // timer half-opens it and preparation resumes with a fresh budget.
            assert.ok(internal.unifiedAgentImageRetryTimer);
            t.mock.timers.tick(UNIFIED_AGENT_IMAGE_CIRCUIT_COOLDOWN_MS);
            await internal.pendingBackgroundRefresh;
            const halfOpened = registry.getOperationalStatus().unifiedAgentImage;
            assert.strictEqual(halfOpened.circuitBreakerOpen, undefined);
            assert.strictEqual(halfOpened.circuitOpenedAt, undefined);
            assert.strictEqual(halfOpened.retryCount, 1);
            assert.strictEqual(enqueuePreparation.mock.callCount(), UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS);
        } finally {
            internal.clearUnifiedAgentImageRetry();
        }
    });
}

test('AgentRegistry continues recovery when the retry timer fires one millisecond before the wall-clock deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    t.mock.method(Math, 'random', () => 0.5);
    const registry = AgentRegistry.getInstance();
    registry.setImagePreparationOwner(false);
    const internal = registry as unknown as {
        recordUnavailableUnifiedAgentImage: (imageTag: string, error: string) => void;
        pendingBackgroundRefresh: Promise<void> | null;
        unifiedAgentImageRetryTimer: NodeJS.Timeout | null;
        clearUnifiedAgentImageRetry: () => void;
    };
    enqueuePreparation.mock.mockImplementation(async () => { throw new Error('temporary failure'); });
    internal.recordUnavailableUnifiedAgentImage('propr/agent:early-timer', 'temporary failure');
    const deadline = Date.parse(registry.getOperationalStatus().unifiedAgentImage.nextRetryAt!);
    t.mock.method(Date, 'now', () => deadline - 1);
    try {
        t.mock.timers.tick(5_000);
        await internal.pendingBackgroundRefresh;
        assert.strictEqual(enqueuePreparation.mock.callCount(), 1);
        assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.retryCount, 2);
        assert.ok(internal.unifiedAgentImageRetryTimer);
    } finally {
        internal.clearUnifiedAgentImageRetry();
    }
});

for (const outcome of ['unavailable', 'ready', 'circuit-open'] as const) {
    test(`AgentRegistry re-evaluates a consumed timer after an overlapping refresh becomes ${outcome}`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
        t.mock.method(Math, 'random', () => 0.5);
        const registry = AgentRegistry.getInstance();
        registry.setImagePreparationOwner(false);
        const internal = registry as unknown as {
            recordUnavailableUnifiedAgentImage: (imageTag: string, error: string) => void;
            markUnifiedAgentImageReady: (imageTag: string) => string;
            pendingBackgroundRefresh: Promise<void> | null;
            unifiedAgentImageRetryTimer: NodeJS.Timeout | null;
            clearUnifiedAgentImageRetry: () => void;
        };
        let release!: () => void;
        const imageTag = 'propr/agent:overlapping-refresh';
        internal.pendingBackgroundRefresh = new Promise<void>(resolve => { release = resolve; })
            .then(() => {
                if (outcome === 'ready') internal.markUnifiedAgentImageReady(imageTag);
                if (outcome === 'circuit-open') internal.recordUnavailableUnifiedAgentImage(imageTag, 'ENOSPC');
            })
            .finally(() => { internal.pendingBackgroundRefresh = null; });
        internal.recordUnavailableUnifiedAgentImage(imageTag, 'temporary failure');
        enqueuePreparation.mock.mockImplementation(async () => { throw new Error('temporary failure'); });
        try {
            t.mock.timers.tick(5_000);
            assert.strictEqual(enqueuePreparation.mock.callCount(), 0);
            assert.strictEqual(internal.unifiedAgentImageRetryTimer, null);
            const refresh = internal.pendingBackgroundRefresh;
            release();
            await refresh;
            await new Promise<void>(resolve => setImmediate(resolve));
            if (outcome === 'unavailable') {
                assert.ok(internal.unifiedAgentImageRetryTimer);
                t.mock.timers.tick(1);
                await internal.pendingBackgroundRefresh;
                assert.strictEqual(enqueuePreparation.mock.callCount(), 1);
                assert.ok(internal.unifiedAgentImageRetryTimer);
                assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.retryCount, 2);
            } else {
                assert.strictEqual(internal.unifiedAgentImageRetryTimer, null);
                assert.strictEqual(enqueuePreparation.mock.callCount(), 0);
            }
        } finally {
            release();
            internal.clearUnifiedAgentImageRetry();
        }
    });
}

for (const owner of [false, true]) {
    for (const error of ['temporary download failure', 'docker build failed: no space left on device']) {
        test(`AgentRegistry blocks on-demand recovery with an open circuit (owner=${owner}): ${error}`, async () => {
            const registry = AgentRegistry.getInstance();
            registry.setImagePreparationOwner(owner);
            const prepare = mock.method(registry, 'prepareImagesAndRefresh', async () => {});
            const internal = registry as unknown as {
                initialized: boolean;
                recordUnavailableUnifiedAgentImage: (imageTag: string, error: string) => void;
                startWorkerOwnedImageRecovery: () => Promise<void>;
                registeredAgentImagesAvailable: () => Promise<boolean>;
            };
            internal.initialized = true;
            internal.registeredAgentImagesAvailable = async () => false;
            do {
                internal.recordUnavailableUnifiedAgentImage('propr/agent:bundle-retry', error);
            } while (!registry.getOperationalStatus().unifiedAgentImage.circuitBreakerOpen);
            const status = registry.getOperationalStatus();

            await internal.startWorkerOwnedImageRecovery();
            await registry.recoverImagesAndRefresh();
            await registry.ensureInitialized();
            await registry.ensureInitialized();

            assert.strictEqual(enqueuePreparation.mock.callCount(), 0);
            assert.deepStrictEqual(registry.getOperationalStatus(), status);
            assert.strictEqual(prepare.mock.callCount(), 0);
            // Startup can fail before initialization completes. An automatic
            // queue request must still preserve that failure and its circuit.
            internal.initialized = false;
            await registry.recoverImagesAndRefresh();
            assert.deepStrictEqual(registry.getOperationalStatus(), status);
            assert.strictEqual(prepare.mock.callCount(), 0);
        });
    }
}

for (const error of ['temporary download failure', 'docker build failed: no space left on device']) {
    test(`AgentRegistry recovers with an open circuit once the worker-prepared image appears: ${error}`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
        const registry = AgentRegistry.getInstance();
        registry.setImagePreparationOwner(false);
        const internal = registry as unknown as {
            initialized: boolean;
            ensureUnifiedAgentImage: () => Promise<string | null>;
            recordUnavailableUnifiedAgentImage: (tag: string, error: string, attemptFailed?: boolean) => void;
            registeredAgentImagesAvailable: () => Promise<boolean>;
            markUnifiedAgentImageReady: (tag: string) => string;
            clearUnifiedAgentImageRetry: () => void;
        };
        const imageTag = 'propr/agent:worker-prepared';
        let available = false;
        internal.initialized = true;
        internal.registeredAgentImagesAvailable = async () => false;
        internal.ensureUnifiedAgentImage = async () => {
            if (available) return internal.markUnifiedAgentImageReady(imageTag);
            internal.recordUnavailableUnifiedAgentImage(imageTag, 'not prepared', false);
            return null;
        };
        do {
            internal.recordUnavailableUnifiedAgentImage(imageTag, error);
        } while (!registry.getOperationalStatus().unifiedAgentImage.circuitBreakerOpen);
        const openStatus = registry.getOperationalStatus().unifiedAgentImage;
        try {
            // Inside the inspection interval the open circuit stays quiet.
            await registry.ensureInitialized();
            assert.deepStrictEqual(registry.getOperationalStatus().unifiedAgentImage, openStatus);
            // A later inspection observes the image still missing without
            // counting an attempt or requesting preparation.
            t.mock.timers.tick(60_000);
            await registry.ensureInitialized();
            const inspected = registry.getOperationalStatus().unifiedAgentImage;
            assert.strictEqual(inspected.circuitBreakerOpen, true);
            assert.strictEqual(inspected.retryCount, openStatus.retryCount);
            assert.strictEqual(registry.getAllAgents().length, 0);
            // Once the worker has prepared the image, the next inspection
            // clears the failure and registers agents without a build request.
            t.mock.timers.tick(60_000);
            available = true;
            await registry.ensureInitialized();
            assert.deepStrictEqual(registry.getOperationalStatus(), { unifiedAgentImage: { status: 'ready' } });
            assert.ok(registry.getAgentByAlias('opencode'));
            assert.strictEqual(enqueuePreparation.mock.callCount(), 0);
        } finally {
            internal.clearUnifiedAgentImageRetry();
        }
    });
}

test('AgentRegistry inspects an open circuit in the background while retained agents remain usable', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const registry = AgentRegistry.getInstance();
    registry.setImagePreparationOwner(false);
    const internal = registry as unknown as {
        ensureUnifiedAgentImage: () => Promise<string | null>;
        registeredAgentImagesAvailable: () => Promise<boolean>;
        recordUnavailableUnifiedAgentImage: (tag: string, error: string, attemptFailed?: boolean) => void;
        markUnifiedAgentImageReady: (tag: string) => string;
        circuitOpenInspection: { after: number; pending: Promise<void> | null };
        clearUnifiedAgentImageRetry: () => void;
    };
    internal.registeredAgentImagesAvailable = async () => true;
    internal.ensureUnifiedAgentImage = async () => internal.markUnifiedAgentImageReady('propr/agent:a');
    await registry.refresh();
    assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:a');
    let available = false;
    internal.ensureUnifiedAgentImage = async () => {
        if (available) return internal.markUnifiedAgentImageReady('propr/agent:b');
        internal.recordUnavailableUnifiedAgentImage('propr/agent:b', 'not prepared', false);
        return null;
    };
    do {
        internal.recordUnavailableUnifiedAgentImage('propr/agent:b', 'temporary download failure');
    } while (!registry.getOperationalStatus().unifiedAgentImage.circuitBreakerOpen);
    try {
        // Inside the inspection interval the open circuit stays quiet and the
        // retained agents keep serving their available image.
        await registry.ensureInitialized();
        assert.strictEqual(internal.circuitOpenInspection.pending, null);
        assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:a');
        assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.circuitBreakerOpen, true);
        // Once the worker has prepared the replacement image, a later guard
        // adopts it through the background inspection without a build request.
        t.mock.timers.tick(60_000);
        available = true;
        await registry.ensureInitialized();
        await internal.circuitOpenInspection.pending;
        assert.deepStrictEqual(registry.getOperationalStatus(), { unifiedAgentImage: { status: 'ready' } });
        assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:b');
        assert.strictEqual(enqueuePreparation.mock.callCount(), 0);
    } finally {
        internal.clearUnifiedAgentImageRetry();
    }
});

for (const error of ['temporary download failure', 'docker build failed: no space left on device']) {
    test(`AgentRegistry bounds a transient open circuit but keeps disk pressure open: ${error}`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
        const registry = AgentRegistry.getInstance();
        registry.setImagePreparationOwner(false);
        const internal = registry as unknown as {
            initialized: boolean;
            ensureUnifiedAgentImage: () => Promise<string | null>;
            recordUnavailableUnifiedAgentImage: (tag: string, error: string, attemptFailed?: boolean) => void;
            startWorkerOwnedImageRecovery: () => Promise<void>;
            registeredAgentImagesAvailable: () => Promise<boolean>;
            pendingBackgroundRefresh: Promise<void> | null;
            clearUnifiedAgentImageRetry: () => void;
        };
        const imageTag = 'propr/agent:cooldown';
        const operatorActionRequired = error.includes('no space');
        internal.initialized = true;
        internal.registeredAgentImagesAvailable = async () => false;
        internal.ensureUnifiedAgentImage = async () => {
            internal.recordUnavailableUnifiedAgentImage(imageTag, 'not prepared', false);
            return null;
        };
        enqueuePreparation.mock.mockImplementation(async () => { throw new Error(error); });
        do {
            internal.recordUnavailableUnifiedAgentImage(imageTag, error);
        } while (!registry.getOperationalStatus().unifiedAgentImage.circuitBreakerOpen);
        try {
            const opened = registry.getOperationalStatus().unifiedAgentImage;
            assert.strictEqual(opened.operatorActionRequired, operatorActionRequired || undefined);
            assert.strictEqual(opened.circuitOpenedAt, new Date().toISOString());

            // Inside the cooldown the circuit stays open, and the inspect-only
            // observations it permits must not push the cooldown out.
            t.mock.timers.tick(UNIFIED_AGENT_IMAGE_CIRCUIT_COOLDOWN_MS - 1);
            await internal.startWorkerOwnedImageRecovery();
            await internal.pendingBackgroundRefresh;
            const waiting = registry.getOperationalStatus().unifiedAgentImage;
            assert.strictEqual(waiting.circuitBreakerOpen, true);
            assert.strictEqual(waiting.circuitOpenedAt, opened.circuitOpenedAt);
            assert.strictEqual(enqueuePreparation.mock.callCount(), 0);

            // Once the cooldown elapses, only an operator can release disk
            // pressure; a transient circuit resumes with a fresh retry budget.
            t.mock.timers.tick(1);
            await internal.startWorkerOwnedImageRecovery();
            await internal.pendingBackgroundRefresh;
            const resumed = registry.getOperationalStatus().unifiedAgentImage;
            assert.strictEqual(enqueuePreparation.mock.callCount(), operatorActionRequired ? 0 : 1);
            assert.strictEqual(resumed.circuitBreakerOpen, operatorActionRequired ? true : undefined);
            if (!operatorActionRequired) assert.strictEqual(resumed.retryCount, 1);
        } finally {
            internal.clearUnifiedAgentImageRetry();
        }
    });
}

test('AgentRegistry exposes a throttled inspect-only availability check for a blocked startup', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
    const registry = AgentRegistry.getInstance();
    registry.setImagePreparationOwner(true);
    const prepare = t.mock.method(registry, 'prepareImagesAndRefresh', async () => {});
    const refreshes = t.mock.method(registry, 'refresh');
    const internal = registry as unknown as {
        ensureUnifiedAgentImage: () => Promise<string | null>;
        recordUnavailableUnifiedAgentImage: (tag: string, error: string, attemptFailed?: boolean) => void;
        registeredAgentImagesAvailable: () => Promise<boolean>;
        markUnifiedAgentImageReady: (tag: string) => string;
        circuitOpenInspection: { after: number; pending: Promise<void> | null };
        clearUnifiedAgentImageRetry: () => void;
    };
    const imageTag = 'propr/agent:startup';
    let available = false;
    internal.registeredAgentImagesAvailable = async () => available;
    internal.ensureUnifiedAgentImage = async () => {
        if (available) return internal.markUnifiedAgentImageReady(imageTag);
        internal.recordUnavailableUnifiedAgentImage(imageTag, 'not prepared', false);
        return null;
    };
    do {
        internal.recordUnavailableUnifiedAgentImage(imageTag, 'temporary download failure');
    } while (!registry.getOperationalStatus().unifiedAgentImage.circuitBreakerOpen);
    try {
        // The startup gate polls every second; the check stays throttled and
        // never requests a build of its own.
        for (let poll = 0; poll < 3; poll += 1) await registry.inspectAgentImageAvailability();
        assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.status, 'unavailable');
        assert.strictEqual(refreshes.mock.callCount(), 0);

        // An image prepared by another process clears the failure through the
        // inspect-only refresh, without bypassing the recovery circuit.
        t.mock.timers.tick(60_000);
        available = true;
        await registry.inspectAgentImageAvailability();
        await internal.circuitOpenInspection.pending;
        assert.deepStrictEqual(registry.getOperationalStatus(), { unifiedAgentImage: { status: 'ready' } });
        assert.strictEqual(refreshes.mock.callCount(), 1);

        // A ready registry needs no further inspection.
        t.mock.timers.tick(60_000);
        await registry.inspectAgentImageAvailability();
        assert.strictEqual(refreshes.mock.callCount(), 1);
        assert.strictEqual(prepare.mock.callCount(), 0);
        assert.strictEqual(enqueuePreparation.mock.callCount(), 0);
    } finally {
        internal.clearUnifiedAgentImageRetry();
    }
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

    internal.recordUnavailableUnifiedAgentImage('propr/agent:bundle-recovered', 'ENOSPC');
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

for (const owner of [false, true]) {
    test(`AgentRegistry honors retry deadlines for removed images (owner=${owner})`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
        t.mock.method(Math, 'random', () => 0.5);
        const registry = AgentRegistry.getInstance();
        registry.setImagePreparationOwner(owner);
        const imageTag = 'propr/agent:removed';
        const internal = registry as unknown as {
            ensureUnifiedAgentImage: () => Promise<string | null>;
            registeredAgentImagesAvailable: () => Promise<boolean>;
            recordUnavailableUnifiedAgentImage: (tag: string, error: string, attemptFailed?: boolean) => void;
            pendingBackgroundRefresh: Promise<void> | null;
            clearUnifiedAgentImageRetry: () => void;
        };
        internal.ensureUnifiedAgentImage = async () => imageTag;
        await registry.refresh();
        internal.registeredAgentImagesAvailable = async () => false;
        let attempts = 0;
        internal.ensureUnifiedAgentImage = async () => {
            attempts += 1;
            internal.recordUnavailableUnifiedAgentImage(imageTag, 'temporary build failure');
            return null;
        };
        enqueuePreparation.mock.mockImplementation(async () => {
            attempts += 1;
            throw new Error('temporary build failure');
        });
        try {
            await registry.ensureInitialized();
            assert.strictEqual(attempts, 1);
            const deadline = registry.getOperationalStatus().unifiedAgentImage.nextRetryAt;
            t.mock.timers.tick(1_000);
            internal.recordUnavailableUnifiedAgentImage(imageTag, 'not prepared', false);
            assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.nextRetryAt, deadline);
            await Promise.all([registry.ensureInitialized(), registry.recoverImagesAndRefresh()]);
            assert.strictEqual(attempts, 1);
            t.mock.timers.tick(4_000);
            await internal.pendingBackgroundRefresh;
            await registry.ensureInitialized();
            assert.strictEqual(attempts, 2);
            assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.retryCount, 2);
        } finally {
            internal.clearUnifiedAgentImageRetry();
        }
    });
}

test('AgentRegistry preserves disk-pressure circuit on inspect-only observations of the same image', async () => {
    const registry = AgentRegistry.getInstance();
    registry.setImagePreparationOwner(false);
    const internal = registry as unknown as {
        recordUnavailableUnifiedAgentImage: (tag: string, error: string, attemptFailed?: boolean) => void;
        startWorkerOwnedImageRecovery: () => Promise<void>;
        clearUnifiedAgentImageRetry: () => void;
    };
    internal.recordUnavailableUnifiedAgentImage('propr/agent:full', 'ENOSPC');
    internal.recordUnavailableUnifiedAgentImage('propr/agent:full', 'not prepared', false);
    const status = registry.getOperationalStatus().unifiedAgentImage;
    assert.strictEqual(status.circuitBreakerOpen, true);
    assert.strictEqual(status.operatorActionRequired, true);
    assert.strictEqual(status.nextRetryAt, undefined);
    await internal.startWorkerOwnedImageRecovery();
    assert.strictEqual(enqueuePreparation.mock.callCount(), 0);
    internal.recordUnavailableUnifiedAgentImage('propr/agent:different', 'not prepared', false);
    assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.circuitBreakerOpen, undefined);
    assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.operatorActionRequired, undefined);
    internal.clearUnifiedAgentImageRetry();
});

for (const useDefault of [false, true]) {
    test(`AgentRegistry queues missing runtime packages on first use (default=${useDefault})`, async () => {
        const registry = AgentRegistry.getInstance();
        registry.setImagePreparationOwner(false);
        if (useDefault) await saveAgents([]);
        const previousImage = process.env.AGENT_DOCKER_IMAGE;
        if (useDefault) process.env.AGENT_DOCKER_IMAGE = 'custom/agent:default';
        const state = {
            installationId: 'test-runtime', packages: ['jq'], activePackages: ['jq'],
            status: 'ready' as const, images: {}, updatedAt: new Date().toISOString(),
        };
        await saveAgentRuntimePackageState(state);
        unexpectedBuild.mock.resetCalls();
        dockerCommand.mock.mockImplementation(async (_command, args) => ({
            exitCode: 0, stderr: '', messageTimestamps: new Map(),
            stdout: args[0] === 'run' ? 'apt\nPRETTY_NAME="Debian"' : 'sha256:base\t"node"',
        }));
        let finishPreparation!: () => void;
        const preparationGate = new Promise<void>(resolve => { finishPreparation = resolve; });
        let requested!: () => void;
        const requestStarted = new Promise<void>(resolve => { requested = resolve; });
        enqueuePreparation.mock.mockImplementation(async imageTag => {
            requested();
            await preparationGate;
            await saveAgentRuntimePackageState({
                ...state,
                images: { [imageTag]: {
                    baseImage: imageTag, baseImageId: 'sha256:base', image: 'propr/runtime-agent:ready',
                    packageManager: 'apt', builtAt: new Date().toISOString(),
                } },
            });
        });
        try {
            const initialization = registry.ensureInitialized();
            await requestStarted;
            assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.status, 'unavailable');
            assert.strictEqual(registry.getAllAgents().length, 0);
            finishPreparation();
            await initialization;
            assert.strictEqual(enqueuePreparation.mock.callCount(), 1);
            assert.strictEqual(unexpectedBuild.mock.callCount(), 0);
            assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.status, 'ready');
            assert.strictEqual(registry.getAgentByAlias(useDefault ? 'default' : 'opencode')?.config.dockerImage,
                'propr/runtime-agent:ready');
        } finally {
            finishPreparation();
            if (previousImage === undefined) delete process.env.AGENT_DOCKER_IMAGE;
            else process.env.AGENT_DOCKER_IMAGE = previousImage;
        }
    });
}


for (const recover of [true, false]) {
    test(`worker retries a failed configuration while retaining working agents (recover=${recover})`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
        t.mock.method(Math, 'random', () => 0.5);
        const registry = AgentRegistry.getInstance();
        const internal = registry as unknown as {
            ensureUnifiedAgentImage: (_configs: AgentConfig[], prepare: boolean) => Promise<string | null>;
            registeredAgentImagesAvailable: () => Promise<boolean>;
            recordUnavailableUnifiedAgentImage: (tag: string, error: string) => void;
            markUnifiedAgentImageReady: (tag: string) => string;
            pendingBackgroundRefresh: Promise<void> | null;
            clearUnifiedAgentImageRetry: () => void;
        };
        internal.ensureUnifiedAgentImage = async () => internal.markUnifiedAgentImageReady('propr/agent:a');
        internal.registeredAgentImagesAvailable = async () => true;
        await registry.prepareImagesAndRefresh();
        let attempts = 0;
        internal.ensureUnifiedAgentImage = async (_configs, prepare) => {
            assert.strictEqual(prepare, true);
            attempts += 1;
            if (recover && attempts === 3) return internal.markUnifiedAgentImageReady('propr/agent:b');
            internal.recordUnavailableUnifiedAgentImage('propr/agent:b', 'temporary download failure');
            return null;
        };
        try {
            await registry.prepareImagesAndRefresh();
            assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, 'propr/agent:a');
            for (let count = 1; count < (recover ? 3 : 5); count += 1) {
                await registry.ensureInitialized();
                assert.strictEqual(attempts, count, 'executions respect the retry deadline');
                t.mock.timers.tick(getUnifiedAgentImageRetryDelay(count, () => 0.5));
                await internal.pendingBackgroundRefresh;
            }
            const status = registry.getOperationalStatus().unifiedAgentImage;
            assert.strictEqual(status.status, recover ? 'ready' : 'unavailable');
            assert.strictEqual(status.circuitBreakerOpen, recover ? undefined : true);
            assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, recover ? 'propr/agent:b' : 'propr/agent:a');
            t.mock.timers.tick(10 * 60_000);
            await internal.pendingBackgroundRefresh;
            // A transient circuit half-opens after its cooldown, so the owner
            // makes one further attempt instead of staying degraded forever.
            assert.strictEqual(attempts, recover ? 3 : 6);
            assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.circuitBreakerOpen, undefined);
            assert.strictEqual(registry.getAgentByAlias('opencode')?.config.dockerImage, recover ? 'propr/agent:b' : 'propr/agent:a');
            assert.strictEqual(enqueuePreparation.mock.callCount(), 0);
        } finally {
            internal.clearUnifiedAgentImageRetry();
        }
    });
}

for (const replacement of ['ready-b', 'unavailable-b', 'ready-a']) {
    test(`obsolete ENOSPC recovery cannot overwrite ${replacement}`, async () => {
        const registry = AgentRegistry.getInstance();
        registry.setImagePreparationOwner(false);
        const internal = registry as unknown as {
            ensureUnifiedAgentImage: () => Promise<string | null>;
            recordUnavailableUnifiedAgentImage: (tag: string, error: string, attempted?: boolean) => void;
            markUnifiedAgentImageReady: (tag: string) => string;
            startWorkerOwnedImageRecovery: () => Promise<void>;
            clearUnifiedAgentImageRetry: () => void;
        };
        internal.ensureUnifiedAgentImage = async () => internal.markUnifiedAgentImageReady('propr/agent:a');
        await registry.refresh();
        internal.recordUnavailableUnifiedAgentImage('propr/agent:a', 'not prepared', false);
        let fail!: (error: Error) => void;
        enqueuePreparation.mock.mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
        const recovery = internal.startWorkerOwnedImageRecovery();
        const image = replacement === 'ready-a' ? 'propr/agent:a' : 'propr/agent:b';
        internal.ensureUnifiedAgentImage = async () => {
            if (replacement === 'unavailable-b') {
                internal.recordUnavailableUnifiedAgentImage(image, 'not prepared', false);
                return null;
            }
            return internal.markUnifiedAgentImageReady(image);
        };
        try {
            await registry.refresh();
            const currentStatus = registry.getOperationalStatus();
            fail(new Error('ENOSPC from superseded preparation'));
            await recovery;
            assert.deepStrictEqual(registry.getOperationalStatus(), currentStatus);
            internal.recordUnavailableUnifiedAgentImage(image, 'removed again', false);
            enqueuePreparation.mock.mockImplementation(async () => { throw new Error('temporary failure'); });
            await internal.startWorkerOwnedImageRecovery();
            assert.strictEqual(enqueuePreparation.mock.calls.at(-1)?.arguments[0], image);
            assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.retryCount, 1);
            assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.circuitBreakerOpen, undefined);
        } finally {
            internal.clearUnifiedAgentImageRetry();
        }
    });
}

test('guarded recovery discovers an uninitialized registry before preparing its missing image', async () => {
    const registry = AgentRegistry.getInstance();
    const modes: boolean[] = [];
    const internal = registry as unknown as {
        ensureUnifiedAgentImage: (_configs: AgentConfig[], prepare: boolean) => Promise<string | null>;
        recordUnavailableUnifiedAgentImage: (tag: string, error: string, attempted: boolean) => void;
        markUnifiedAgentImageReady: (tag: string) => string;
    };
    internal.ensureUnifiedAgentImage = async (_configs, prepare) => {
        modes.push(prepare);
        if (prepare) return internal.markUnifiedAgentImageReady('propr/agent:required');
        internal.recordUnavailableUnifiedAgentImage('propr/agent:required', 'not prepared', false);
        return null;
    };
    await registry.recoverImagesAndRefresh();
    assert.deepStrictEqual(modes, [false, true]);
    assert.strictEqual(registry.isInitialized(), true);
    assert.strictEqual(registry.getOperationalStatus().unifiedAgentImage.status, 'ready');
    assert.strictEqual(enqueuePreparation.mock.callCount(), 0);
});
