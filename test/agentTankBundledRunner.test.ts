/**
 * Bundled Agent Tank runner.
 *
 * The expensive failure this guards is container churn: `executeWithUsageTracking`
 * probes usage around every LLM call, so without TTL caching and in-flight
 * coalescing a burst of calls would each start their own container.
 */

import { after, afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
/** Consumed one run at a time; `dockerResult` answers every run after it. */
let dockerResultQueue: ExecutionResult[] = [];

const CONTAINER_CONFIG_FILE = '/tmp/propr-agent-tank/config.json';
const CONFIG_ENV_PREFIX = 'PROPR_AGENT_TANK_CONFIG=';

/** The `--mount` specs of a run, in order. */
function bindMounts(args: string[]): string[] {
    return args.filter((_arg, index) => args[index - 1] === '--mount');
}

/**
 * The spec the runner must produce for a credential directory: `--mount`
 * (not `-v`) so the daemon refuses a source that is missing on the host
 * instead of creating an empty directory in its place.
 */
function mountSpec(hostPath: string, containerPath: string): string {
    return `type=bind,source=${hostPath},target=${containerPath},readonly`;
}

/** The container command (everything after the image). */
function containerCommand(args: string[]): string[] {
    return args.slice(args.indexOf('propr/agent:test') + 1);
}

function configEnvValue(args: string[]): string {
    const entry = args.find(arg => arg.startsWith(CONFIG_ENV_PREFIX));
    assert.ok(entry, 'the run carries no generated Agent Tank config');
    return entry.slice(CONFIG_ENV_PREFIX.length);
}

await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        executeDockerCommand: async (_command: string, args: string[]): Promise<ExecutionResult> => {
            dockerRuns.push(args);
            if (dockerGate) await dockerGate;
            return dockerResultQueue.shift() ?? dockerResult;
        },
    },
});

// Two host credential directories that actually exist, because the runner
// deliberately skips any agent whose credentials are not readable.
const credentialRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-tank-test-'));
const claudeHome = path.join(credentialRoot, 'claude');
const codexHome = path.join(credentialRoot, 'codex');
// A second Claude account, for the case where two aliases share one provider.
const secondaryClaudeHome = path.join(credentialRoot, 'claude-secondary');
fs.mkdirSync(claudeHome);
fs.mkdirSync(codexHome);
fs.mkdirSync(secondaryClaudeHome);

let configuredAgents: AgentConfig[] = [];

await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        loadAgentTankSettings: async () => ({ mode: 'bundled', enabled: true, url: '' }),
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
    canRunBundledAgentTank,
    clearBundledAgentTankCache,
    getBundledStatusForAlias,
    getBundledStatusesForDelta,
    missingBindSources,
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
    dockerResultQueue = [];
    dockerResult = { exitCode: 0, stdout: SAMPLE_OUTPUT, stderr: '', messageTimestamps: new Map() };
    configuredAgents = [
        agent({ alias: 'claude', type: 'claude', configPath: claudeHome }),
        agent({ alias: 'codex', type: 'codex', configPath: codexHome }),
    ];
    clearBundledAgentTankCache();
    delete process.env.AGENT_TANK_BUNDLED_CACHE_TTL_MS;
    // The test process may itself be a container, so pin the namespace question
    // instead of letting `/.dockerenv` decide it.
    process.env.PROPR_CONTAINERIZED = '0';
});

afterEach(() => {
    clearBundledAgentTankCache();
    delete process.env.PROPR_CONTAINERIZED;
    delete process.env.AGENT_TANK_BUNDLED_TIMEOUT_MS;
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
    assert.ok(args.includes(mountSpec(claudeHome, '/home/node/.claude')));
    assert.ok(args.includes(mountSpec(codexHome, '/home/node/.codex')));
    assert.ok(args.includes('propr/agent:test'));
    const command = containerCommand(args);
    assert.match(command[2], /exec agent-tank --once --json --config "\$1"/);
    assert.deepEqual(command.slice(-2), ['propr-agent-tank', CONTAINER_CONFIG_FILE]);
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
        { provider: 'claude', alias: 'claude', configPath: '/home/node/.claude' },
        { provider: 'agy', alias: 'antigravity', configPath: '/home/node/.gemini' },
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

test('the generated config is never bind-mounted from the backend filesystem', async () => {
    await refreshBundledStatuses();

    // The host daemon resolves every `-v` source on the host, so a pathname that
    // only exists inside the backend container would silently become an empty
    // directory in the agent container. Only credential directories - which went
    // through the deployment's host mapping - may be bind sources here.
    const mounts = bindMounts(dockerRuns[0]);
    assert.deepEqual(mounts, [
        mountSpec(claudeHome, '/home/node/.claude'),
        mountSpec(codexHome, '/home/node/.codex'),
    ]);
    assert.equal(mounts.some(mount => mount.includes(CONTAINER_CONFIG_FILE)), false);
});

test('the run carries the generated config and the container writes it itself', async () => {
    await refreshBundledStatuses();

    const args = dockerRuns[0];
    const command = containerCommand(args);
    assert.equal(command[0], 'sh');
    assert.equal(command[1], '-c');

    // Actually run the bootstrap the way the container would: it must reproduce
    // the generated config byte for byte at the container config path, with no
    // host-visible file involved anywhere.
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'propr-tank-bootstrap-')), 'nested', 'config.json');
    const expected = configEnvValue(args);
    // `agent-tank` only exists in the agent image, so the final exec is swapped
    // for a no-op; everything before it is the part under test.
    assert.ok(command[2].includes('node /home/node/agent-tank-runtime.mjs "$1"'));
    const bootstrap = command[2].replace('node /home/node/agent-tank-runtime.mjs "$1";', '')
        .replace('exec agent-tank', 'exec true');
    execFileSync('sh', ['-c', bootstrap, command[3], target], {
        env: { ...process.env, PROPR_AGENT_TANK_CONFIG: expected },
    });
    assert.equal(fs.readFileSync(target, 'utf8'), expected);

    const config = JSON.parse(expected) as { agents: { provider: string; configPath: string }[] };
    assert.deepEqual(config.agents.map(entry => entry.provider), ['claude', 'codex']);
    assert.deepEqual(config.agents.map(entry => entry.configPath), ['/home/node/.claude', '/home/node/.codex']);
    // The runner wrote nothing outside the container: this is the test's own
    // scratch directory, not something the refresh left behind.
    fs.rmSync(path.dirname(path.dirname(target)), { recursive: true, force: true });
});

test('cache-only capacity reads reuse a snapshot without starting a container', async () => {
    await refreshBundledStatuses();
    assert.equal(dockerRuns.length, 1);

    // Cache-only reads inside the freshness window see the same snapshot
    // twice. The wrapper also rejects unchanged provider snapshots (covered by
    // usageTrackingBundledDelta) - and neither read may start a container.
    const preCall = getBundledStatusesForDelta();
    const postCall = getBundledStatusesForDelta();

    assert.ok(preCall);
    assert.equal(postCall, preCall);
    assert.equal((preCall.claude.usage.session as { percent: number }).percent, 42);
    assert.equal(dockerRuns.length, 1);

    // A refresh that lands between two calls is what makes a real delta
    // measurable, so the reader must hand out the newer snapshot afterwards.
    dockerResult = {
        exitCode: 0,
        stdout: JSON.stringify({ claude: { name: 'claude', usage: { session: { percent: 58 } } } }),
        stderr: '',
        messageTimestamps: new Map(),
    };
    await refreshBundledStatuses({ force: true });

    const refreshed = getBundledStatusesForDelta();
    assert.equal((refreshed?.claude.usage.session as { percent: number }).percent, 58);
});

test('an alias-specific read only answers for the account whose credentials were inspected', async () => {
    // Two Claude accounts, the secondary one first. Provider dedup keeps only
    // `claude-secondary`'s credentials, but Agent Tank labels the result with the
    // provider key `claude` - so without provenance the snapshot would be handed
    // out as the capacity of alias `claude`, which is a different account.
    configuredAgents = [
        agent({ alias: 'claude-secondary', type: 'claude', configPath: secondaryClaudeHome }),
        agent({ alias: 'claude', type: 'claude', configPath: claudeHome }),
    ];
    clearBundledAgentTankCache();

    await refreshBundledStatuses();

    // Only the first enabled Claude account was mounted, so it is the only
    // account the snapshot can describe.
    assert.ok(dockerRuns[0].includes(mountSpec(secondaryClaudeHome, '/home/node/.claude')));
    assert.equal(dockerRuns[0].includes(mountSpec(claudeHome, '/home/node/.claude')), false);

    assert.equal(getBundledStatusForAlias('claude'), undefined);
    assert.equal(getBundledStatusForAlias('claude-secondary')?.name, 'claude');
});

test('an alias-specific read follows the order the aliases are configured in', async () => {
    // Same two accounts, opposite order: now the snapshot really is alias
    // `claude`'s, and the secondary alias is the one that must get nothing.
    configuredAgents = [
        agent({ alias: 'claude', type: 'claude', configPath: claudeHome }),
        agent({ alias: 'claude-secondary', type: 'claude', configPath: secondaryClaudeHome }),
    ];
    clearBundledAgentTankCache();

    await refreshBundledStatuses();

    assert.equal(getBundledStatusForAlias('claude')?.name, 'claude');
    assert.equal(getBundledStatusForAlias('claude-secondary'), undefined);
});

test('an alias-specific read reports nothing once the snapshot is too stale to trust', async () => {
    await refreshBundledStatuses();
    assert.ok(getBundledStatusForAlias('claude'));

    // Past the delta freshness window the snapshot is no longer evidence about
    // the account's current capacity.
    assert.equal(getBundledStatusForAlias('claude', { maxAgeMs: -1 }), undefined);
});

test('an alias-specific read reports nothing when no run has succeeded', () => {
    clearBundledAgentTankCache();

    assert.equal(getBundledStatusForAlias('claude'), undefined);
});

test('a credential directory the backend cannot see is still handed to the Docker daemon', async () => {
    // The backend runs in its own container and drives the host daemon, so a
    // credential directory that went through the deployment's host mapping does
    // not have to exist in *this* filesystem. Skipping it here would leave a
    // correctly configured install with no Agent Tank container at all.
    process.env.PROPR_CONTAINERIZED = '1';
    const hostOnlyClaude = '/host-only/propr-agent-tank/.claude';
    assert.equal(fs.existsSync(hostOnlyClaude), false);
    configuredAgents = [agent({ alias: 'claude', type: 'claude', configPath: hostOnlyClaude })];
    clearBundledAgentTankCache();

    const result = await refreshBundledStatuses();

    assert.equal(dockerRuns.length, 1);
    assert.deepEqual(bindMounts(dockerRuns[0]), [mountSpec(hostOnlyClaude, '/home/node/.claude')]);
    assert.ok(result?.claude);
});

test('bundled detection offers the feature for credentials only the Docker host can see', async () => {
    process.env.PROPR_CONTAINERIZED = '1';
    configuredAgents = [agent({ alias: 'codex', type: 'codex', configPath: '/host-only/propr-agent-tank/.codex' })];

    assert.equal(await canRunBundledAgentTank(), true);
});

test('a credential directory absent from a host-sharing backend is still skipped', async () => {
    // The opposite over-correction: when this process *is* the daemon's
    // filesystem, a missing directory really is missing and mounting it would
    // hand Agent Tank an empty credential home.
    process.env.PROPR_CONTAINERIZED = '0';
    configuredAgents = [
        agent({ alias: 'claude', type: 'claude', configPath: path.join(credentialRoot, 'nope') }),
        agent({ alias: 'codex', type: 'codex', configPath: codexHome }),
    ];
    clearBundledAgentTankCache();

    await refreshBundledStatuses();

    assert.deepEqual(bindMounts(dockerRuns[0]), [mountSpec(codexHome, '/home/node/.codex')]);
    assert.equal(await canRunBundledAgentTank(), true);
});

test('a bind source the daemon rejects drops that agent instead of the whole run', async () => {
    process.env.PROPR_CONTAINERIZED = '1';
    const hostOnlyClaude = '/host-only/propr-agent-tank/.claude';
    configuredAgents = [
        agent({ alias: 'claude', type: 'claude', configPath: hostOnlyClaude }),
        agent({ alias: 'codex', type: 'codex', configPath: codexHome }),
    ];
    clearBundledAgentTankCache();
    // Only the daemon can answer "does this exist on the host?", and it answers
    // by refusing to start the container. The other account's usage must not go
    // down with it.
    dockerResultQueue = [{
        exitCode: 125,
        stdout: '',
        stderr: 'docker: Error response from daemon: invalid mount config for type "bind": '
            + `bind source path does not exist: ${hostOnlyClaude}.`,
        messageTimestamps: new Map(),
    }];

    const result = await refreshBundledStatuses();

    assert.equal(dockerRuns.length, 2);
    assert.deepEqual(bindMounts(dockerRuns[1]), [mountSpec(codexHome, '/home/node/.codex')]);
    assert.ok(result?.codex);
});

test('the daemon error naming a missing bind source is parsed back to the path', () => {
    assert.deepEqual(
        missingBindSources('docker: Error response from daemon: invalid mount config for type "bind": '
            + 'bind source path does not exist: /host/only/.claude.'),
        ['/host/only/.claude'],
    );
    assert.deepEqual(missingBindSources('some other docker failure'), []);
});

for (const executingAlias of ['claude-primary', 'claude-secondary']) {
    test(`per-call tracking uses cached credential provenance for ${executingAlias}`, async () => {
        const { executeWithUsageTracking } = await import('../packages/core/src/agents/impl/utils/usageTrackingWrapper.js');
        configuredAgents = [
            agent({ alias: 'claude-primary', configPath: claudeHome }),
            agent({ alias: 'claude-secondary', configPath: secondaryClaudeHome }),
        ];
        await refreshBundledStatuses();
        const { result, usageMetrics } = await executeWithUsageTracking('claude', async () => {
            // Let the baseline settle and change the provider response for the
            // post-call refresh.
            await new Promise(resolve => setImmediate(resolve));
            dockerResult = { ...dockerResult, stdout: JSON.stringify({
                claude: { name: 'claude', usage: { session: { percent: 58 } }, lastUpdated: '2026-09-26T00:01:00.000Z' },
            }) };
            return 'output';
        }, undefined, executingAlias);
        assert.equal(result, 'output');
        assert.equal(dockerRuns.length, executingAlias === 'claude-primary' ? 2 : 1);
        assert.ok(bindMounts(dockerRuns[0]).includes(mountSpec(claudeHome, '/home/node/.claude')));
        if (executingAlias === 'claude-primary') {
            assert.deepEqual(usageMetrics?.records, [{ agent: 'claude', metricKey: 'Session', metricValue: 16 }]);
        } else {
            assert.equal(usageMetrics, null, 'the uninspected account must not inherit the primary account delta');
        }
    });
}

for (const provider of ['claude', 'codex', 'antigravity'] as const) {
    for (const baseline of ['cold', 'fresh', 'stale'] as const) {
        test(`${provider} records a 91s call with a ${baseline} worker cache`, async (t) => {
            const { executeWithUsageTracking } = await import('../packages/core/src/agents/impl/utils/usageTrackingWrapper.js');
            t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
            const key = provider === 'antigravity' ? 'agy' : provider;
            const alias = `${provider}-primary`;
            configuredAgents = [agent({ type: provider, alias })];
            const output = (percent: number) => JSON.stringify({
                [key]: { name: key, usage: { session: { percent } }, lastUpdated: new Date().toISOString() },
            });
            dockerResult.stdout = output(42);
            if (baseline !== 'cold') await refreshBundledStatuses();
            if (baseline === 'stale') {
                // Capacity gauges may accept older data; a per-call baseline
                // must still obey its own freshness window.
                process.env.AGENT_TANK_BUNDLED_CACHE_TTL_MS = '300000';
                t.mock.timers.tick(91_000);
            }
            const { result, usageMetrics } = await executeWithUsageTracking(provider, async () => {
                // Wait for the wrapper's own cold-cache run, including its
                // dynamic image import, without warming it from another caller.
                for (let attempt = 0; !getBundledStatusForAlias(alias) && attempt < 100; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 1));
                }
                assert.ok(getBundledStatusForAlias(alias), 'the wrapper populated its worker cache');
                await new Promise(resolve => setImmediate(resolve));
                t.mock.timers.tick(91_000);
                assert.equal(getBundledStatusForAlias(alias), undefined, 'the baseline has aged out of the shared cache');
                dockerResult.stdout = output(58);
                return 'output';
            }, undefined, alias);
            assert.equal(result, 'output');
            assert.deepEqual(usageMetrics?.records, [{ agent: provider, metricKey: 'Session', metricValue: 16 }]);
            assert.equal(usageMetrics?.postCall.lastUpdated, new Date().toISOString());
            assert.equal(dockerRuns.length, baseline === 'stale' ? 3 : 2);
        });
    }
}

test('post-call capture waits past an older in-flight refresh and runs again', async () => {
    const { executeWithUsageTracking } = await import('../packages/core/src/agents/impl/utils/usageTrackingWrapper.js');
    await refreshBundledStatuses();
    let release = () => {};
    let olderRun: Promise<unknown> | undefined;
    const { usageMetrics } = await executeWithUsageTracking('claude', async () => {
        await new Promise(resolve => setImmediate(resolve));
        dockerGate = new Promise<void>(resolve => { release = resolve; });
        dockerResultQueue = [
            { ...dockerResult, stdout: JSON.stringify({ claude: { name: 'claude', usage: { session: { percent: 45 } } } }) },
            { ...dockerResult, stdout: JSON.stringify({ claude: { name: 'claude', usage: { session: { percent: 58 } } } }) },
        ];
        olderRun = refreshBundledStatuses({ force: true });
        await new Promise(resolve => setImmediate(resolve));
        // Finish this container only after the post-call phase has begun.
        setImmediate(release);
        return 'output';
    });
    await olderRun;
    assert.equal(dockerRuns.length, 3);
    assert.deepEqual(usageMetrics?.records, [{ agent: 'claude', metricKey: 'Session', metricValue: 16 }]);
});

test('a failed post-call refresh cannot reuse a still-fresh baseline', async () => {
    const { executeWithUsageTracking } = await import('../packages/core/src/agents/impl/utils/usageTrackingWrapper.js');
    await refreshBundledStatuses();
    const { result, usageMetrics } = await executeWithUsageTracking('claude', async () => {
        await new Promise(resolve => setImmediate(resolve));
        dockerResult.exitCode = 1;
        return 'output';
    });
    assert.equal(result, 'output');
    assert.equal(usageMetrics, null);
    assert.ok(getBundledStatusForAlias('claude'), 'failed refresh retains the capacity cache');
});

test('the post-call budget includes an older run and starts no deferred run after timeout', async () => {
    const { executeWithUsageTracking } = await import('../packages/core/src/agents/impl/utils/usageTrackingWrapper.js');
    process.env.AGENT_TANK_BUNDLED_TIMEOUT_MS = '10';
    await refreshBundledStatuses();
    let release = () => {};
    let olderRun: Promise<unknown> | undefined;
    const { result, usageMetrics } = await executeWithUsageTracking('claude', async () => {
        await new Promise(resolve => setImmediate(resolve));
        dockerGate = new Promise<void>(resolve => { release = resolve; });
        olderRun = refreshBundledStatuses({ force: true });
        await new Promise(resolve => setImmediate(resolve));
        return 'output';
    });
    assert.equal(result, 'output');
    assert.equal(usageMetrics, null);
    release();
    await olderRun;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dockerRuns.length, 2);
});

after(async () => {
    const { closeConnection } = await import('../packages/core/src/db/connection.js');
    await closeConnection();
});
