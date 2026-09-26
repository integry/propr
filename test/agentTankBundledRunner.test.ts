/**
 * Bundled Agent Tank runner.
 *
 * The expensive failure this guards is container churn: `executeWithUsageTracking`
 * probes usage around every LLM call, so without TTL caching and in-flight
 * coalescing a burst of calls would each start their own container.
 */

import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentConfig } from '../packages/core/src/agents/types.js';
import type { ExecutionResult } from '../packages/core/src/claude/docker/dockerExecutor.js';

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

let dockerRuns: string[][] = [];
let dockerResult: ExecutionResult = {
    exitCode: 0,
    stdout: '{}',
    stderr: '',
    messageTimestamps: new Map(),
};
/** Held open so concurrent callers overlap and coalescing is actually exercised. */
let dockerGate: Promise<void> | undefined;

await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        executeDockerCommand: async (_command: string, args: string[]): Promise<ExecutionResult> => {
            dockerRuns.push(args);
            if (dockerGate) await dockerGate;
            return dockerResult;
        },
    },
});

// Two host credential directories that actually exist, because the runner
// deliberately skips any agent whose credentials are not readable.
const credentialRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-tank-test-'));
const claudeHome = path.join(credentialRoot, 'claude');
const codexHome = path.join(credentialRoot, 'codex');
fs.mkdirSync(claudeHome);
fs.mkdirSync(codexHome);

let configuredAgents: AgentConfig[] = [];

await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        loadAgents: async (): Promise<AgentConfig[]> => configuredAgents,
        resolveConfigPath: (configPath: string): string => configPath,
        resolveCodexConfigPath: (configPath: string): string => configPath,
    },
});

await mock.module('../packages/core/src/agents/AgentRegistry.js', {
    namedExports: {
        AgentRegistry: {
            getInstance: () => ({ getAllAgents: () => [{ config: { dockerImage: 'propr/agent:test' } }] }),
        },
    },
});

const {
    buildBundledAgentTankConfig,
    clearBundledAgentTankCache,
    parseBundledAgentTankOutput,
    refreshBundledStatuses,
} = await import('../packages/core/src/services/agentTankBundledRunner.js');

function agent(overrides: Partial<AgentConfig>): AgentConfig {
    return {
        id: overrides.alias || 'agent',
        type: 'claude',
        alias: 'claude',
        enabled: true,
        dockerImage: 'propr/agent:test',
        configPath: claudeHome,
        supportedModels: [],
        ...overrides,
    } as AgentConfig;
}

const SAMPLE_OUTPUT = JSON.stringify({
    claude: { name: 'claude', usage: { session: { percent: 42 } }, lastUpdated: '2026-09-26T00:00:00.000Z' },
    codex: { name: 'codex', usage: { fiveHour: { percentUsed: 3 } } },
});

beforeEach(() => {
    dockerRuns = [];
    dockerGate = undefined;
    dockerResult = { exitCode: 0, stdout: SAMPLE_OUTPUT, stderr: '', messageTimestamps: new Map() };
    configuredAgents = [
        agent({ alias: 'claude', type: 'claude', configPath: claudeHome }),
        agent({ alias: 'codex', type: 'codex', configPath: codexHome }),
    ];
    clearBundledAgentTankCache();
    delete process.env.AGENT_TANK_BUNDLED_CACHE_TTL_MS;
});

afterEach(() => {
    clearBundledAgentTankCache();
});

test('ten concurrent refreshes coalesce onto exactly one container run', async () => {
    // Hold the fake docker call open so all ten requests are genuinely in flight.
    let unblock: () => void = () => {};
    dockerGate = new Promise<void>(resolve => { unblock = resolve; });

    const pending = Array.from({ length: 10 }, () => refreshBundledStatuses());
    unblock();
    const results = await Promise.all(pending);

    assert.equal(dockerRuns.length, 1);
    for (const result of results) {
        assert.ok(result?.claude.usage.session);
    }
});

test('a second refresh inside the TTL spawns no container at all', async () => {
    await refreshBundledStatuses();
    assert.equal(dockerRuns.length, 1);

    await refreshBundledStatuses();
    assert.equal(dockerRuns.length, 1);
});

test('forcing a refresh bypasses the cache', async () => {
    await refreshBundledStatuses();
    await refreshBundledStatuses({ force: true });

    assert.equal(dockerRuns.length, 2);
});

test('a failed run returns undefined and leaves the previous snapshot intact', async () => {
    const good = await refreshBundledStatuses();
    assert.ok(good?.claude);

    dockerResult = { exitCode: 1, stdout: '', stderr: 'boom', messageTimestamps: new Map() };
    const failed = await refreshBundledStatuses({ force: true });
    assert.equal(failed, undefined);

    // The good snapshot must survive: a transient container failure should not
    // blank out usable data.
    const cached = await refreshBundledStatuses();
    assert.ok(cached?.claude);
});

test('credential directories are mounted read-only at the agent runtime container paths', async () => {
    await refreshBundledStatuses();

    const args = dockerRuns[0];
    assert.ok(args.includes(`${claudeHome}:/home/node/.claude:ro`));
    assert.ok(args.includes(`${codexHome}:/home/node/.codex:ro`));
    assert.ok(args.includes('propr/agent:test'));
    assert.deepEqual(args.slice(-5), ['agent-tank', '--once', '--json', '--config', '/tmp/propr-agent-tank/config.json']);
});

test('unsupported providers are left out rather than failing the whole run', async () => {
    configuredAgents = [
        agent({ alias: 'opencode', type: 'opencode', configPath: claudeHome }),
        agent({ alias: 'vibe', type: 'vibe', configPath: codexHome }),
    ];
    clearBundledAgentTankCache();

    const result = await refreshBundledStatuses();

    // Nothing to inspect means no container, and an empty (not failed) result.
    assert.deepEqual(result, {});
    assert.equal(dockerRuns.length, 0);
});

test('the generated config uses the upstream provider/configPath schema', () => {
    const config = JSON.parse(buildBundledAgentTankConfig([
        { provider: 'claude', configPath: '/home/node/.claude' },
        { provider: 'agy', configPath: '/home/node/.gemini' },
    ]));

    assert.deepEqual(config.agents, [
        { provider: 'claude', id: 'claude', configPath: '/home/node/.claude' },
        { provider: 'agy', id: 'agy', configPath: '/home/node/.gemini' },
    ]);
    assert.equal(config.dockerAccess, false);
});

test('output parsing accepts a bare status map, an agents envelope, and leading banner text', () => {
    const bare = parseBundledAgentTankOutput('{"claude":{"name":"claude","usage":{"session":{"percent":7}}}}');
    assert.equal((bare.claude.usage.session as { percent: number }).percent, 7);

    const enveloped = parseBundledAgentTankOutput('{"agents":{"agy":{"name":"agy","usage":{}}}}');
    assert.equal(enveloped.agy.name, 'agy');

    const withBanner = parseBundledAgentTankOutput('Agent Tank starting…\n{"codex":{"name":"codex","usage":{}}}');
    assert.equal(withBanner.codex.name, 'codex');
});

test('output parsing degrades to an empty map instead of throwing', () => {
    assert.deepEqual(parseBundledAgentTankOutput(''), {});
    assert.deepEqual(parseBundledAgentTankOutput('no json here'), {});
    assert.deepEqual(parseBundledAgentTankOutput('{ not json'), {});
});
