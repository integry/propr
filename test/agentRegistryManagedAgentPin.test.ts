import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentConfig } from '../packages/core/src/agents/types.js';
import type { ExecutionResult } from '../packages/core/src/claude/docker/dockerExecutor.js';

const silentLogger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} };
await mock.module('../packages/core/src/utils/logger.js', { defaultExport: { ...silentLogger, child: () => silentLogger } });

const enqueuePreparation = mock.fn(async (_imageTag: string): Promise<void> => {});
await mock.module('../packages/core/src/agents/agentImagePreparationQueue.js', {
    namedExports: { enqueueAgentImagePreparation: enqueuePreparation, closeAgentImagePreparationQueue: async () => {} },
});

// A local Docker engine holding only what the scenario cached. Generated
// bundles are never present and building one hits the observed disk guard.
const REVISION = 'd2a18303b2c4bcab68783edd4f84246dd37a98fe';
const PIN = `propr/agent:${REVISION}@sha256:2d28d73aa7f5cffc18dc9929f4d910894848346f5ae65690eaa95610f2f33fd9`;
const engine = new Map<string, { platform: string; labels: Record<string, string> }>();
const dockerCalls: string[][] = [];
const result = (exitCode: number, stdout = '', stderr = ''): ExecutionResult => ({ exitCode, stdout, stderr, messageTimestamps: new Map() } as ExecutionResult);
const dockerCommand = mock.fn(async (_command: string, args: string[]): Promise<ExecutionResult> => {
    dockerCalls.push(args);
    if (args[0] === 'image' && args[1] === 'inspect') {
        const images = args.slice(args.indexOf('--format') + 2);
        if (!images.every(image => engine.has(image))) return result(1, '', 'No such image');
        if (args[args.indexOf('--format') + 1].includes('Labels')) {
            const image = engine.get(images[0])!;
            return result(0, `${image.platform}\t${JSON.stringify(image.labels)}`);
        }
        return result(0, images.map(() => 'sha256:local').join('\n'));
    }
    if (args[0] === 'pull') {
        if (args[1] !== PIN) return result(1, '', 'manifest unknown');
        engine.set(PIN, publishedPinImage());
        return result(0, 'pulled');
    }
    throw new Error(`Unexpected Docker command: ${args.join(' ')}`);
});
const ensureAgentBundleImage = mock.fn(async (_versions: Record<string, string>, _contentHash: string) => ({
    success: false, imageTag: 'propr/agent:bundle-generated', error: 'no space left on device',
}));
const ensureAgentDockerImage = mock.fn(async (_type: string, _image: string): Promise<boolean> => false);
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        executeDockerCommand: dockerCommand,
        agentDockerImageExists: async () => false,
        ensureAgentBundleImage,
        ensureAgentDockerImage,
        getDockerRootDir: async () => '/docker/storage',
    },
});

/** Labels exactly as the final stage of this revision's Dockerfile.agent writes them. */
function publishedPinImage(overrides: Record<string, string> = {}) {
    const dockerfile = fs.readFileSync(path.join(import.meta.dirname, '..', 'Dockerfile.agent'), 'utf8');
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    const arg = (name: string) => {
        const value = new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(finalStage)?.[1];
        assert.ok(value, `Dockerfile.agent final stage must pin ${name}`);
        return value;
    };
    return {
        platform: 'linux/amd64',
        labels: {
            'dev.propr.agent-bundle': 'true',
            'org.opencontainers.image.source': 'https://github.com/integry/propr',
            'org.opencontainers.image.revision': REVISION,
            'dev.propr.agent.claude.version': arg('CLAUDE_CLI_VERSION'),
            'dev.propr.agent.codex.version': arg('CODEX_CLI_VERSION'),
            'dev.propr.agent.antigravity.version': arg('ANTIGRAVITY_CLI_VERSION'),
            'dev.propr.agent.opencode.version': arg('OPENCODE_CLI_VERSION'),
            'dev.propr.agent.vibe.version': arg('VIBE_CLI_VERSION'),
            ...overrides,
        },
    };
}

process.env.NODE_ENV = 'test';
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-managed-agent-'));
process.env.DATA_DIR = testDataDir;

let AgentRegistry: typeof import('../packages/core/src/agents/AgentRegistry.js').AgentRegistry;
let AGENT_DEFAULT_VERSIONS: typeof import('../packages/core/src/agents/version/types.js').AGENT_DEFAULT_VERSIONS;
let configManager: typeof import('../packages/core/src/config/configManager.js');
let closeConnection: () => Promise<void>;

// Explicit rows as an existing Desktop profile stores them after setup.
const configuredRows = (claudeVersion?: string): AgentConfig[] => [
    {
        id: 'claude-1', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'propr/agent:latest',
        configPath: '~/.claude', supportedModels: ['sonnet'], defaultModel: 'sonnet',
        cliVersionType: claudeVersion ? 'specific' : 'default', cliVersion: claudeVersion,
        cliVersionResolved: claudeVersion ?? AGENT_DEFAULT_VERSIONS.claude,
    },
    {
        id: 'codex-1', type: 'codex', alias: 'codex', enabled: true, dockerImage: 'propr/agent:latest',
        configPath: '~/.codex', supportedModels: ['gpt-5'], defaultModel: 'gpt-5',
        cliVersionType: 'default', cliVersionResolved: AGENT_DEFAULT_VERSIONS.codex,
    },
];

const ENV_KEYS = ['PROPR_MANAGED_AGENT_IMAGE', 'PROPR_MANAGED_AGENT_REVISION', 'AGENT_DOCKER_IMAGE'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

/** The app-container environment the launcher produces for a signed manifest. */
function desktopRuntimeEnv(agentDockerImage?: string): void {
    process.env.PROPR_MANAGED_AGENT_IMAGE = PIN;
    process.env.PROPR_MANAGED_AGENT_REVISION = REVISION;
    if (agentDockerImage) process.env.AGENT_DOCKER_IMAGE = agentDockerImage;
}

function freshRegistry(owner: boolean) {
    (AgentRegistry as unknown as { instance?: unknown }).instance = undefined;
    const registry = AgentRegistry.getInstance();
    registry.setImagePreparationOwner(owner);
    return registry;
}

const builtOrPulledBundle = () => ensureAgentBundleImage.mock.callCount() + ensureAgentDockerImage.mock.callCount();

before(async () => {
    ({ AgentRegistry } = await import('../packages/core/src/agents/AgentRegistry.js'));
    ({ AGENT_DEFAULT_VERSIONS } = await import('../packages/core/src/agents/version/types.js'));
    configManager = await import('../packages/core/src/config/configManager.js');
    const connection = await import('../packages/core/src/db/connection.js');
    closeConnection = connection.closeConnection;
    await connection.runMigrations();
});

beforeEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    engine.clear();
    dockerCalls.length = 0;
    enqueuePreparation.mock.resetCalls();
    ensureAgentBundleImage.mock.resetCalls();
    ensureAgentDockerImage.mock.resetCalls();
    await configManager.saveSettings({ default_agent_alias: null });
});

after(async () => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    (AgentRegistry as unknown as { instance?: unknown }).instance = undefined;
    await closeConnection();
    fs.rmSync(testDataDir, { recursive: true, force: true });
});

for (const owner of [true, false]) {
    test(`configured default-version agents run the cached published pin without a bundle (${owner ? 'worker' : 'api'})`, async () => {
        desktopRuntimeEnv(PIN);
        engine.set(PIN, publishedPinImage());
        await configManager.saveAgents(configuredRows());

        const registry = freshRegistry(owner);
        await (owner ? registry.prepareImagesAndRefresh() : registry.refresh());

        assert.equal(registry.getOperationalStatus().unifiedAgentImage.status, 'ready');
        assert.deepEqual(registry.getAllAgents().map(agent => agent.config.dockerImage), [PIN, PIN]);
        assert.equal(builtOrPulledBundle(), 0);
        assert.equal(enqueuePreparation.mock.callCount(), 0);
        assert.ok(dockerCalls.every(args => args[0] !== 'pull'), 'a cached pin is not pulled again');
        assert.deepEqual(await configManager.loadEffectiveAgentBaseImages(), [PIN]);
    });
}

test('a registry halted on the generated bundle by the disk guard recovers onto the cached pin inspect-only', async () => {
    desktopRuntimeEnv(PIN);
    await configManager.saveAgents(configuredRows());
    const registry = freshRegistry(false);
    const internal = registry as unknown as { recordUnavailableUnifiedAgentImage(tag: string, error: string): void; clearUnifiedAgentImageRetry(): void };
    internal.recordUnavailableUnifiedAgentImage('propr/agent:bundle-05fdcec709f6-6d52b8', 'no space left on device');
    assert.equal(registry.getOperationalStatus().unifiedAgentImage.operatorActionRequired, true);

    engine.set(PIN, publishedPinImage());
    await registry.refresh();

    assert.equal(registry.getOperationalStatus().unifiedAgentImage.status, 'ready');
    assert.equal(registry.getAgentByAlias('claude')?.config.dockerImage, PIN);
    assert.equal(builtOrPulledBundle(), 0);
    internal.clearUnifiedAgentImageRetry();
});

test('the worker prepares a missing pin only by its exact digest, then verifies it', async () => {
    desktopRuntimeEnv();
    await configManager.saveAgents(configuredRows());
    const registry = freshRegistry(true);
    await registry.prepareImagesAndRefresh();

    assert.deepEqual(dockerCalls.filter(args => args[0] === 'pull'), [['pull', PIN]]);
    assert.equal(registry.getAgentByAlias('codex')?.config.dockerImage, PIN);
    assert.equal(builtOrPulledBundle(), 0);
});

test('a pin whose labels do not match this revision is reported, never rebuilt or substituted', async () => {
    desktopRuntimeEnv(PIN);
    engine.set(PIN, publishedPinImage({ 'org.opencontainers.image.revision': 'f'.repeat(40) }));
    await configManager.saveAgents(configuredRows());
    const registry = freshRegistry(true);
    await registry.prepareImagesAndRefresh();

    const status = registry.getOperationalStatus().unifiedAgentImage;
    assert.equal(status.status, 'unavailable');
    assert.equal(status.imageTag, PIN);
    assert.match(status.error ?? '', /failed verification: its revision label/);
    assert.equal(builtOrPulledBundle(), 0);
    (registry as unknown as { clearUnifiedAgentImageRetry(): void }).clearUnifiedAgentImageRetry();
});

test('an intentional custom CLI version keeps its derived bundle instead of the pin', async () => {
    desktopRuntimeEnv(PIN);
    engine.set(PIN, publishedPinImage());
    await configManager.saveAgents(configuredRows('2.1.300'));
    const registry = freshRegistry(true);
    await registry.prepareImagesAndRefresh();

    assert.equal(ensureAgentBundleImage.mock.callCount(), 1);
    assert.equal(ensureAgentBundleImage.mock.calls[0].arguments[0].claude, '2.1.300');
    assert.equal(registry.getOperationalStatus().unifiedAgentImage.imageTag, 'propr/agent:bundle-generated');
    assert.ok(registry.getAllAgents().every(agent => agent.config.dockerImage !== PIN));
    const [effective] = await configManager.loadEffectiveAgentBaseImages();
    assert.match(effective, /^propr\/agent:bundle-/);
    (registry as unknown as { clearUnifiedAgentImageRetry(): void }).clearUnifiedAgentImageRetry();
});

test('an empty configuration with the migrated AGENT_DOCKER_IMAGE registers the default agent on the pin', async () => {
    desktopRuntimeEnv(PIN);
    engine.set(PIN, publishedPinImage());
    await configManager.saveAgents([]);
    const registry = freshRegistry(false);
    await registry.refresh();

    assert.equal(registry.getAgentByAlias('default')?.config.dockerImage, PIN);
    assert.equal(builtOrPulledBundle(), 0);
});

test('generic runtimes without a bound pin keep the generated-bundle and configured-image paths', async () => {
    engine.set(PIN, publishedPinImage());
    await configManager.saveAgents(configuredRows());
    await freshRegistry(true).prepareImagesAndRefresh();
    assert.equal(ensureAgentBundleImage.mock.callCount(), 1);

    process.env.AGENT_DOCKER_IMAGE = 'custom/agent:default';
    await configManager.saveAgents([]);
    const registry = freshRegistry(true);
    await registry.prepareImagesAndRefresh();
    assert.deepEqual(ensureAgentDockerImage.mock.calls.map(call => call.arguments[1]), ['custom/agent:default']);
    assert.deepEqual(await configManager.loadEffectiveAgentBaseImages(), ['custom/agent:default']);
    (registry as unknown as { clearUnifiedAgentImageRetry(): void }).clearUnifiedAgentImageRetry();
});

test('a pin that is not bound to its declared revision is ignored', async () => {
    process.env.PROPR_MANAGED_AGENT_IMAGE = PIN;
    process.env.PROPR_MANAGED_AGENT_REVISION = 'e'.repeat(40);
    engine.set(PIN, publishedPinImage());
    await configManager.saveAgents(configuredRows());
    const registry = freshRegistry(true);
    await registry.prepareImagesAndRefresh();
    assert.equal(ensureAgentBundleImage.mock.callCount(), 1);
    (registry as unknown as { clearUnifiedAgentImageRetry(): void }).clearUnifiedAgentImageRetry();
});
