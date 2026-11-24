import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

type Call = { command: string; args: string[]; options: Record<string, any> };
const calls: Call[] = [];
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, messageTimestamps: new Map() });
let respond: (call: Call) => Promise<any> = async () => ok();

await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        executeDockerCommand: async (command: string, args: string[], options: Record<string, any> = {}) => {
            const call = { command, args, options };
            calls.push(call);
            return respond(call);
        },
    },
});

process.env.PROPR_COMPUTE_USAGE_SAMPLE_MS = '15';

const { runAgent, registerAgentRuntime } = await import('../packages/core/src/agents/runtime/registry.ts');
const { DockerRuntime } = await import('../packages/core/src/agents/runtime/dockerRuntime.ts');
const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
const {
    COMPUTE_RATES_ENV, formatComputeUsage, loadComputeRateTable, normalizeComputeUsage, priceComputeUsage, withComputeCost,
} = await import('../packages/core/src/agents/runtime/computeUsage.ts');
const { ComputeUsageAccumulator, parseCgroupReport, parseDockerSize, parseDockerStatsLine } = await import('../packages/core/src/agents/runtime/computeUsageSampler.ts');
const { resolveComputeUsageSampleMs, DEFAULT_COMPUTE_USAGE_SAMPLE_MS } = await import('../packages/core/src/agents/runtime/dockerComputeUsage.ts');

const GIB = 1024 ** 3;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function spec(name = 'claude-issue-7-usage') {
    return new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent:test', name, stdin: true,
        network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false },
    }).workspaceMount().command('claude', '-p', '-').build();
}

function usage(overrides: Record<string, unknown> = {}) {
    return {
        runtime: 'fly', wallTimeMs: 3_600_000, cpuSeconds: 1800, peakMemoryBytes: 2 * GIB, avgMemoryBytes: GIB,
        costUsd: null, costSource: null, ...overrides,
    } as Parameters<typeof withComputeCost>[0];
}

test('rate table: parsed per runtime, invalid tables are ignored rather than guessed', () => {
    assert.deepEqual(loadComputeRateTable({}), {});
    assert.deepEqual(loadComputeRateTable({ [COMPUTE_RATES_ENV]: '{"Fly":{"perHourUsd":0.02,"perGiBHourUsd":0.005}}' }), {
        fly: { perHourUsd: 0.02, perGiBHourUsd: 0.005 },
    });
    for (const invalid of ['nope', '[]', '{"fly":1}', '{"fly":{"perMinuteUsd":1}}', '{"fly":{"perHourUsd":-1}}', '{"fly":{"perHourUsd":"1"}}']) {
        assert.deepEqual(loadComputeRateTable({ [COMPUTE_RATES_ENV]: invalid }), {}, invalid);
    }
});

test('pricing adds every given rate; a rate needing an unmeasured figure leaves the cost unknown', () => {
    // 1 h × $0.02 + 1800 CPU-s × $0.00001 + 1 GiB (average) × 1 h × $0.005
    assert.equal(priceComputeUsage(usage(), { perHourUsd: 0.02, perCpuSecondUsd: 0.00001, perGiBHourUsd: 0.005 }), 0.043);
    assert.equal(priceComputeUsage(usage({ avgMemoryBytes: null }), { perGiBHourUsd: 0.005 }), 0.01, 'peak stands in for a missing average');
    assert.equal(priceComputeUsage(usage({ cpuSeconds: null }), { perCpuSecondUsd: 0.00001 }), null);
    assert.equal(priceComputeUsage(usage({ peakMemoryBytes: null, avgMemoryBytes: null }), { perGiBHourUsd: 1 }), null);
});

test('a runtime-provided cost wins; otherwise the runtime kind\'s rate prices it; otherwise it stays unknown', () => {
    const table = { fly: { perHourUsd: 0.5 } };
    assert.deepEqual(withComputeCost(usage({ costUsd: 0.07, costSource: 'runtime' }), table), usage({ costUsd: 0.07, costSource: 'runtime' }));
    assert.deepEqual(withComputeCost(usage(), table), usage({ costUsd: 0.5, costSource: 'rate_table' }));
    assert.deepEqual(withComputeCost(usage({ runtime: 'docker' }), table), usage({ runtime: 'docker' }));
});

test('stored usage is read back defensively and summarised without unmeasured figures', () => {
    assert.equal(normalizeComputeUsage(null), null);
    assert.equal(normalizeComputeUsage({ runtime: 'docker' }), null);
    assert.deepEqual(normalizeComputeUsage({ runtime: 'docker', wallTimeMs: 1000, cpuSeconds: -1, costUsd: 2, costSource: 'bogus' }), {
        runtime: 'docker', wallTimeMs: 1000, cpuSeconds: null, peakMemoryBytes: null, avgMemoryBytes: null, costUsd: null, costSource: null,
    });
    assert.equal(formatComputeUsage(usage({ wallTimeMs: 252_000, cpuSeconds: 182.44, peakMemoryBytes: 1.2 * GIB, avgMemoryBytes: 640 * 1024 ** 2, costUsd: 0.03, costSource: 'rate_table' })),
        'fly · 4m 12s wall · 182.4 CPU-s · peak 1.2 GiB (avg 640 MiB) · $0.03 (rate table)');
    assert.equal(formatComputeUsage(usage({ runtime: 'docker', wallTimeMs: 38_000, cpuSeconds: null, peakMemoryBytes: null, avgMemoryBytes: null })), 'docker · 38s wall');
    assert.equal(formatComputeUsage(usage({ wallTimeMs: 1000, costUsd: 0.0004, costSource: 'runtime' })).endsWith('$0.0004'), true);
});

test('accumulator: time-weighted memory, kernel peak, cumulative CPU extended to the exit', () => {
    const accumulator = new ComputeUsageAccumulator(0);
    accumulator.record({ atMs: 10_000, cpuSeconds: 5, memoryBytes: 100, memoryPeakBytes: 400 });
    accumulator.record({ atMs: 30_000, cpuSeconds: 15, memoryBytes: 200 });
    const result = accumulator.finish(40_000, 'docker');
    // Memory: 100 for 10 s, 200 for 20 s. CPU: 15 s by 30 s at 0.5 CPU-s/s for the last 10 s.
    assert.deepEqual(result, {
        runtime: 'docker', wallTimeMs: 40_000, cpuSeconds: 20, peakMemoryBytes: 400, avgMemoryBytes: Math.round(500 / 3),
        costUsd: null, costSource: null,
    });
});

test('accumulator: CPU percentages are integrated when no cumulative reading exists; no samples means unmeasured', () => {
    const accumulator = new ComputeUsageAccumulator(0);
    accumulator.record({ atMs: 2_000, cpuPercent: 50, memoryBytes: 10 });
    accumulator.record({ atMs: 4_000, cpuPercent: 150, memoryBytes: 30 });
    assert.equal(accumulator.finish(4_000, 'docker').cpuSeconds, 4);
    assert.deepEqual(new ComputeUsageAccumulator(0).finish(500, 'docker'), {
        runtime: 'docker', wallTimeMs: 500, cpuSeconds: null, peakMemoryBytes: null, avgMemoryBytes: null, costUsd: null, costSource: null,
    });
});

test('accumulator: the last CPU percentage is extended to the exit like a cumulative rate', () => {
    // Steady 100% CPU: one stats sample at 2 s, exit at 16 s before the next sample.
    const accumulator = new ComputeUsageAccumulator(0);
    accumulator.record({ atMs: 2_000, cpuPercent: 100, memoryBytes: 10 });
    assert.equal(accumulator.finish(16_000, 'docker').cpuSeconds, 16);
});

test('accumulator: percentages after a cumulative reading add to it at their own rate; a later reading supersedes them', () => {
    const accumulator = new ComputeUsageAccumulator(0);
    accumulator.record({ atMs: 10_000, cpuSeconds: 10 });
    // The cgroup becomes unreadable; docker stats reports half a core from here on.
    accumulator.record({ atMs: 20_000, cpuPercent: 50 });
    accumulator.record({ atMs: 30_000, cpuPercent: 50 });
    // 10 s exact, 5 s per 10 s of stats, then 0.5 CPU-s/s for the 10 s unsampled tail.
    assert.equal(accumulator.finish(40_000, 'docker').cpuSeconds, 25);

    // A cumulative reading after the fallback replaces the estimate without double counting.
    accumulator.record({ atMs: 40_000, cpuSeconds: 24 });
    assert.equal(accumulator.finish(40_000, 'docker').cpuSeconds, 24);
    // Rate from the two exact readings: 14 CPU-s over 30 s.
    assert.equal(accumulator.finish(50_000, 'docker').cpuSeconds, 28.667);
});

test('cgroup and docker stats parsing', () => {
    assert.deepEqual(parseCgroupReport('memory.current 1048576\nmemory.peak 2097152\nusage_usec 2500000\nuser_usec 2000000\n', 5), {
        atMs: 5, memoryBytes: 1048576, memoryPeakBytes: 2097152, cpuSeconds: 2.5,
    });
    assert.deepEqual(parseCgroupReport('memory.current 10\n', 1), { atMs: 1, memoryBytes: 10 }, 'no memory.peak before Linux 5.19');
    assert.equal(parseCgroupReport('', 1), null);
    assert.equal(parseDockerSize('512MiB'), 512 * 1024 ** 2);
    assert.equal(parseDockerSize('1.5GB'), 1.5e9);
    assert.equal(parseDockerSize('weird'), null);
    assert.deepEqual(parseDockerStatsLine('12.5%\t256MiB / 2GiB\n', 3), { atMs: 3, cpuPercent: 12.5, memoryBytes: 256 * 1024 ** 2 });
    assert.equal(parseDockerStatsLine('garbage', 3), null);
    assert.equal(resolveComputeUsageSampleMs({}), DEFAULT_COMPUTE_USAGE_SAMPLE_MS);
    assert.equal(resolveComputeUsageSampleMs({ PROPR_COMPUTE_USAGE_SAMPLE_MS: '0' }), 0);
    assert.equal(resolveComputeUsageSampleMs({ PROPR_COMPUTE_USAGE_SAMPLE_MS: 'x' }), DEFAULT_COMPUTE_USAGE_SAMPLE_MS);
});

test('docker runtime samples the container cgroup while it runs and reports usage at completion, priced by the rate table', async () => {
    calls.length = 0;
    let cpuUsec = 0;
    respond = async call => {
        if (call.args[0] === 'run') {
            call.options.agentRun.onSpawn();
            await sleep(120);
            return ok('done');
        }
        if (call.args[0] === 'exec') {
            cpuUsec += 250_000;
            return ok(`memory.current ${256 * 1024 ** 2}\nmemory.peak ${512 * 1024 ** 2}\nusage_usec ${cpuUsec}\n`);
        }
        return ok();
    };
    process.env[COMPUTE_RATES_ENV] = '{"docker":{"perHourUsd":36}}';
    try {
        const result = await runAgent(null, spec(), { timeout: 5_000 });
        const exec = calls.filter(call => call.args[0] === 'exec');
        assert.ok(exec.length >= 2, `sampled ${exec.length} times`);
        assert.deepEqual(exec[0].args.slice(0, 4), ['exec', 'claude-issue-7-usage', 'sh', '-c']);
        const usage = result.computeUsage!;
        assert.equal(usage.runtime, 'docker');
        assert.ok(usage.wallTimeMs >= 100, `wall ${usage.wallTimeMs}`);
        assert.ok(usage.cpuSeconds! >= exec.length * 0.25, `cpu ${usage.cpuSeconds}`);
        assert.equal(usage.peakMemoryBytes, 512 * 1024 ** 2);
        assert.equal(usage.avgMemoryBytes, 256 * 1024 ** 2);
        assert.equal(usage.costSource, 'rate_table');
        assert.equal(usage.costUsd, Math.round(36 * usage.wallTimeMs / 3_600_000 * 1e6) / 1e6);
        // Sampling stops with the run.
        const settled = calls.length;
        await sleep(60);
        assert.equal(calls.length, settled);
    } finally {
        delete process.env[COMPUTE_RATES_ENV];
        respond = async () => ok();
    }
});

test('docker runtime falls back to docker stats when the cgroup cannot be read', async () => {
    calls.length = 0;
    respond = async call => {
        if (call.args[0] === 'run') {
            call.options.agentRun.onSpawn();
            await sleep(150);
            return ok();
        }
        if (call.args[0] === 'exec') return { stdout: '', stderr: 'OCI runtime exec failed: sh: not found', exitCode: 126, messageTimestamps: new Map() };
        if (call.args[0] === 'stats') return ok('100.00%\t1GiB / 4GiB\n');
        return ok();
    };
    try {
        const handle = new DockerRuntime().start(spec('vibe-issue-8-stats'));
        const result = await handle.wait();
        const usage = result.computeUsage!;
        assert.equal(usage.peakMemoryBytes, GIB);
        // A steady 100% workload is measured as one CPU-second per second of the run, tail included.
        assert.ok(Math.abs(usage.cpuSeconds! - usage.wallTimeMs / 1000) <= 0.002, `cpu ${usage.cpuSeconds} wall ${usage.wallTimeMs}`);
        assert.equal(usage.costUsd, null, 'priced only when dispatched through runAgent');
        const exec = calls.filter(call => call.args[0] === 'exec').length;
        const stats = calls.filter(call => call.args[0] === 'stats').length;
        assert.equal(exec, 2, 'two failed cgroup reads switch the sampler to docker stats');
        assert.ok(stats > exec, `stats ${stats}`);
    } finally {
        respond = async () => ok();
    }
});

test('a run that never spawned reports no runtime usage; runAgent still records the wall time it observed', async () => {
    calls.length = 0;
    respond = async () => ok();
    const direct = await new DockerRuntime().start(spec()).wait();
    assert.equal(direct.computeUsage, undefined);
    const dispatched = await runAgent(null, spec(), { timeout: 1_000 });
    assert.equal(dispatched.computeUsage?.runtime, 'docker');
    assert.equal(dispatched.computeUsage?.cpuSeconds, null);
    assert.ok(dispatched.computeUsage!.wallTimeMs >= 0);
});

test('a runtime that reports its own cost keeps it; one reporting nothing is priced from the rate table', async () => {
    const reported = { runtime: 'metered', wallTimeMs: 60_000, cpuSeconds: 30, peakMemoryBytes: null, avgMemoryBytes: null, costUsd: 0.12, costSource: 'runtime' as const };
    const runtimeReturning = (computeUsage?: typeof reported) => () => ({
        kind: 'metered',
        capabilities: { supportsBindMounts: true, supportsRestrictedNetwork: true, supportsMcpPrivateNetwork: true, reattach: false },
        start: (runSpec: ReturnType<typeof spec>) => ({ spec: runSpec, wait: async () => ({ ...ok(), ...(computeUsage && { computeUsage }) }) }),
    }) as any;
    process.env[COMPUTE_RATES_ENV] = '{"metered":{"perHourUsd":60}}';
    try {
        registerAgentRuntime('metered', runtimeReturning(reported));
        assert.deepEqual((await runAgent({ runtime: 'metered' } as any, spec(), {})).computeUsage, reported);
        registerAgentRuntime('metered', runtimeReturning());
        const priced = (await runAgent({ runtime: 'metered' } as any, spec(), {})).computeUsage!;
        assert.equal(priced.runtime, 'metered');
        assert.equal(priced.costSource, 'rate_table');
        assert.equal(priced.costUsd, Math.round(priced.wallTimeMs / 60_000 * 1e6) / 1e6);
    } finally {
        delete process.env[COMPUTE_RATES_ENV];
    }
});
