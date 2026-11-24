import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Writable } from 'node:stream';

type Call = { command: string; args: string[]; options: Record<string, any> };
const calls: Call[] = [];
let respond: (call: Call) => Promise<any> = async () => ({ stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() });

await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        executeDockerCommand: async (command: string, args: string[], options: Record<string, any> = {}) => {
            const call = { command, args, options };
            calls.push(call);
            return respond(call);
        },
    },
});

const { getAgentRuntime, registerAgentRuntime, resolveAgentRuntimeKind, runAgent, assertAgentRuntimeSupports, assertNativeGoalRuntime, AGENT_RUNTIME_ENV } = await import('../packages/core/src/agents/runtime/registry.ts');
const { DockerRuntime, AgentRunStoppedError, AGENT_RUN_OUTPUT_BUFFER_LIMIT_BYTES } = await import('../packages/core/src/agents/runtime/dockerRuntime.ts');
const { OPEN_AGENT_RUN_NETWORK_POLICY } = await import('../packages/core/src/agents/runtime/agentRunNetworkPolicy.ts');
const { executeWithNetworkPolicy, setUnscopedNetworkPolicyResolver } = await import('../packages/core/src/network/egressExecution.ts');
const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
const { renderDockerRunArgs } = await import('../packages/core/src/agents/runtime/dockerRunArgs.ts');
const { containerLaunchKind } = await import('../packages/core/src/agents/runtime/agentRunLaunch.ts');

function spec() {
    return new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent:test', name: 'claude-issue-1-abc', stdin: true, user: '0:0',
        network: agentRunNetwork('bridge'), security: { capAdd: ['CHOWN'] },
        workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false },
    }).workspaceMount().env('A', '1').env('PASS_THROUGH').command('claude', '-p', '-').build();
}

test('runtime selection: docker by default, PROPR_AGENT_RUNTIME, then per-agent config', () => {
    assert.equal(resolveAgentRuntimeKind(undefined, {}), 'docker');
    assert.equal(resolveAgentRuntimeKind(undefined, { [AGENT_RUNTIME_ENV]: 'Docker' }), 'docker');
    assert.throws(() => resolveAgentRuntimeKind(undefined, { [AGENT_RUNTIME_ENV]: 'sprites' }), /Unknown agent runtime "sprites".*PROPR_AGENT_RUNTIME/);
    assert.throws(() => resolveAgentRuntimeKind({ runtime: 'fly' }, {}), /agent configuration/);
    registerAgentRuntime('fake', () => new DockerRuntime());
    assert.equal(resolveAgentRuntimeKind({ runtime: 'fake' }, { [AGENT_RUNTIME_ENV]: 'docker' }), 'fake');
    assert.equal(getAgentRuntime(undefined, {}), getAgentRuntime(undefined, {}));
    assert.throws(() => registerAgentRuntime('Bad Name', () => new DockerRuntime()), /Invalid agent runtime name/);
});

test('docker runtime launches the rendered argv and marks the launch as an agent run', async () => {
    calls.length = 0;
    const run = spec();
    const result = await runAgent(null, run, { timeout: 1000, stdinData: 'prompt' });
    assert.equal(result.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'docker');
    assert.deepEqual(calls[0].args, renderDockerRunArgs(run));
    assert.equal(calls[0].options.stdinData, 'prompt');
    assert.deepEqual(calls[0].options.agentRun.spec, { ...run, network: { ...run.network, policy: OPEN_AGENT_RUN_NETWORK_POLICY } }, 'dispatch attaches the open network policy');
    assert.equal(run.network.policy, undefined, 'the provider spec is not mutated');
    assert.equal(containerLaunchKind('docker', calls[0].args, calls[0].options), 'agent');
    assert.equal(containerLaunchKind('docker', ['run', 'probe'], {}), 'container');
    assert.equal(containerLaunchKind('docker', ['inspect', 'x'], {}), 'command');
    assert.ok(calls[0].args.includes('PASS_THROUGH'), 'value-less variables are passed by name');
});

test('handle streams forward output once read; stop and inspect address the run by name', async () => {
    calls.length = 0;
    let release!: () => void;
    respond = async call => {
        if (call.args[0] === 'run') {
            call.options.agentRun.onSpawn();
            call.options.agentRun.onOutput('stdout', 'hello ');
            await new Promise<void>(resolve => { release = resolve; });
            call.options.agentRun.onOutput('stdout', 'world');
            call.options.agentRun.onOutput('stderr', 'warn');
            return { stdout: 'hello world', stderr: 'warn', exitCode: 0, messageTimestamps: new Map() };
        }
        if (call.args[0] === 'inspect') return { stdout: 'abc123 running\n', stderr: '', exitCode: 0, messageTimestamps: new Map() };
        return { stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() };
    };
    const handle = new DockerRuntime().start(spec());
    const chunks: string[] = [];
    handle.stdout.on('data', chunk => chunks.push(String(chunk)));
    const stderr: string[] = [];
    handle.stderr.on('data', chunk => stderr.push(String(chunk)));
    assert.deepEqual(await handle.inspect(), { liveness: 'running', id: 'abc123', name: 'claude-issue-1-abc' });
    assert.equal(await handle.isAlive(), true);
    let stopped = false;
    const stopping = handle.stop('SIGINT', 5000).then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.at(-1)!.args, ['stop', '--signal', 'SIGINT', '--time', '5', 'claude-issue-1-abc']);
    assert.equal(stopped, false, 'stop resolves only once the run has exited');
    release();
    await stopping;
    assert.equal((await handle.wait()).stdout, 'hello world');
    await new Promise(resolve => handle.stdout.once('end', resolve));
    assert.equal(chunks.join(''), 'world', 'output emitted before the stream was first read is not buffered');
    assert.equal(stderr.join(''), 'warn');

    respond = async () => ({ stdout: '', stderr: 'Error: No such container: claude-issue-1-abc', exitCode: 1, messageTimestamps: new Map() });
    assert.equal((await handle.inspect()).liveness, 'not_found');
    const before = calls.length;
    await handle.stop();
    assert.equal(calls.length, before, 'a settled run needs no docker stop');
});

/** A launch whose preparation (network policy, admission) waits on `prepared` before its Docker client reads the environment. */
function delayedDaemonLaunch() {
    const state = { launchedOn: undefined as string | undefined, prepare: (): void => undefined, release: (): void => undefined };
    respond = async call => {
        if (call.args[0] === 'run') {
            await new Promise<void>(resolve => { state.prepare = resolve; });
            // Like admission's create/start client and the direct spawn: the daemon is chosen once preparation is done.
            state.launchedOn = call.options.extraEnvVars?.DOCKER_HOST ?? 'default';
            call.options.agentRun.onSpawn();
            await new Promise<void>(resolve => { state.release = resolve; });
            return { stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() };
        }
        if (call.args[0] === 'inspect') {
            // Only the daemon the launch actually used knows the run; any other reports it absent.
            return (call.options.extraEnvVars?.DOCKER_HOST ?? 'default') === state.launchedOn
                ? { stdout: 'abc123 running\n', stderr: '', exitCode: 0, messageTimestamps: new Map() }
                : { stdout: '', stderr: 'Error: No such container: claude-issue-1-abc', exitCode: 1, messageTimestamps: new Map() };
        }
        return { stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() };
    };
    return state;
}

for (const restricted of [false, true]) test(`launch, stop, inspect and isAlive address one Docker daemon even if the caller reuses its environment${restricted ? ' (spec-restricted network)' : ''}`, async () => {
    calls.length = 0;
    const launch = delayedDaemonLaunch();
    const launchEnv: Record<string, string> = { DOCKER_HOST: 'tcp://daemon-b:2376', DOCKER_TLS_VERIFY: '1', POLICY_TOKEN: 't' };
    const base = spec();
    // A spec-restricted launch resolves the applying network policy before the executor is even called.
    const run = restricted ? { ...base, network: { ...base.network, restriction: { mode: 'restricted' as const, source: 'workflow' as const, allow: ['registry.npmjs.org'] } } } : base;
    const handle = new DockerRuntime().start(run, { extraEnvVars: launchEnv });
    await new Promise(resolve => setImmediate(resolve));
    // The caller reuses its options object while the launch is still being prepared.
    launchEnv.DOCKER_HOST = 'tcp://daemon-c:2376';
    launchEnv.DOCKER_CONTEXT = 'other';
    launch.prepare();
    await new Promise(resolve => setImmediate(resolve));
    const expected = { DOCKER_HOST: 'tcp://daemon-b:2376', DOCKER_TLS_VERIFY: '1', POLICY_TOKEN: 't' };
    assert.equal(launch.launchedOn, 'tcp://daemon-b:2376', 'the launch keeps the daemon it was started with');
    assert.deepEqual(calls[0].options.extraEnvVars, expected);
    assert.notEqual(calls[0].options.extraEnvVars, launchEnv, 'the launch never holds the caller object');

    assert.deepEqual(await handle.inspect(), { liveness: 'running', id: 'abc123', name: 'claude-issue-1-abc' });
    assert.equal(await handle.isAlive(), true);
    const inspections = calls.filter(call => call.args[0] === 'inspect');
    assert.equal(inspections.length, 2);
    for (const call of inspections) assert.deepEqual(call.options.extraEnvVars, expected);

    const stopping = handle.stop('SIGTERM', 1000);
    await new Promise(resolve => setImmediate(resolve));
    const stop = calls.at(-1)!;
    assert.deepEqual(stop.args, ['stop', '--signal', 'SIGTERM', '--time', '1', 'claude-issue-1-abc']);
    assert.deepEqual(stop.options.extraEnvVars, expected);
    launch.release();
    await stopping;
});

test('launch and control commands keep the default Docker environment when the launch had none', async () => {
    calls.length = 0;
    const launch = delayedDaemonLaunch();
    const launchEnv: Record<string, string> = {};
    const handle = new DockerRuntime().start(spec(), { extraEnvVars: launchEnv });
    await new Promise(resolve => setImmediate(resolve));
    // An initially empty environment the caller fills in later does not retarget the launch either.
    launchEnv.DOCKER_HOST = 'tcp://daemon-c:2376';
    launch.prepare();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(launch.launchedOn, 'default');
    assert.equal('extraEnvVars' in calls[0].options, false);
    assert.equal(await handle.isAlive(), true);
    assert.equal('extraEnvVars' in calls.at(-1)!.options, false);
    launch.release();
    await handle.wait();
});

const OUTPUT_CHUNK = 'x'.repeat(64 * 1024);
const OUTPUT_CHUNKS = 64; // 4 MiB per stream: four times the buffer limit.
const DROPPED_NOTICE = /\n\[propr: (\d+) bytes of agent (stdout|stderr) dropped because the reader fell behind\]\n/g;

/** A verbose run producing sustained output on both streams (yielding between chunks) until released. */
function verboseRun(sample: (handle: any) => void) {
    let produced!: () => void;
    const state = { handle: undefined as any, release: (): void => undefined, produced: new Promise<void>(resolve => { produced = resolve; }) };
    respond = async call => {
        call.options.agentRun.onSpawn();
        // Output starts once the test has subscribed (earlier output is never kept).
        await new Promise(resolve => setImmediate(resolve));
        for (let i = 0; i < OUTPUT_CHUNKS; i++) {
            call.options.agentRun.onOutput('stdout', OUTPUT_CHUNK);
            call.options.agentRun.onOutput('stderr', OUTPUT_CHUNK);
            sample(state.handle);
            await new Promise(resolve => setImmediate(resolve));
        }
        const released = new Promise<void>(resolve => { state.release = resolve; });
        produced();
        await released;
        return { stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() };
    };
    return state;
}

/** Splits what a reader received into agent output and the bytes the stream reported dropped. */
function receivedOutput(text: string, name: string) {
    let dropped = 0;
    for (const match of text.matchAll(DROPPED_NOTICE)) {
        assert.equal(match[2], name);
        dropped += Number(match[1]);
    }
    const output = text.replace(DROPPED_NOTICE, '');
    assert.match(output, /^x*$/, 'only whole agent chunks and drop notices reach the reader');
    return { output: output.length, dropped };
}

/** Everything a handle stream holds for its reader (a duplex also queues on its writable side). */
const pending = (stream: any): number => stream.readableLength + (stream.writableLength ?? 0);

const BOUND = AGENT_RUN_OUTPUT_BUFFER_LIMIT_BYTES + OUTPUT_CHUNK.length;
const PRODUCED = OUTPUT_CHUNK.length * OUTPUT_CHUNKS;

test('handle streams bound what they buffer for a paused reader of stdout and stderr', async () => {
    const run = verboseRun(() => undefined);
    const handle = run.handle = new DockerRuntime().start(spec());
    // Both streams are subscribed (allocated) but nobody reads them.
    const streams = { stdout: handle.stdout, stderr: handle.stderr };
    await run.produced;
    for (const stream of Object.values(streams)) assert.ok(pending(stream) <= BOUND, `paused reader holds ${pending(stream)} bytes`);
    run.release();
    await handle.wait();
    for (const [name, stream] of Object.entries(streams)) {
        const { output, dropped } = receivedOutput(Buffer.concat(await stream.toArray()).toString(), name);
        assert.ok(dropped > 0, `${name} reports the output it dropped`);
        assert.ok(output <= BOUND);
        assert.equal(output + dropped, PRODUCED, `${name} accounts for every produced byte`);
    }
});

test('handle streams bound what they buffer when piped into a slower destination', async () => {
    const peak = { stdout: 0, stderr: 0 };
    const run = verboseRun(handle => {
        if (!handle) return;
        peak.stdout = Math.max(peak.stdout, pending(handle.stdout));
        peak.stderr = Math.max(peak.stderr, pending(handle.stderr));
    });
    const handle = run.handle = new DockerRuntime().start(spec());
    const received = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const finished = (['stdout', 'stderr'] as const).map(name => new Promise<void>(resolve => {
        const slow = new Writable({
            highWaterMark: 16 * 1024,
            write(chunk, _encoding, callback) { received[name].push(chunk); setTimeout(callback, 20); },
        });
        slow.on('finish', resolve);
        handle[name].pipe(slow);
    }));
    await run.produced;
    run.release();
    await handle.wait();
    await Promise.all(finished);
    for (const name of ['stdout', 'stderr'] as const) {
        assert.ok(peak[name] <= BOUND, `${name} buffered at most ${BOUND} bytes for its slow destination (peak ${peak[name]})`);
        const { output, dropped } = receivedOutput(Buffer.concat(received[name]).toString(), name);
        assert.ok(dropped > 0, `${name} reports the output it dropped`);
        assert.equal(output + dropped, PRODUCED, `${name} accounts for every produced byte`);
    }
});

/** A run whose launch preparation (network policy, admission) is pending until released, and which honours the executor's pre-spawn check. */
function pendingLaunch() {
    const state = { spawned: false, release: (): void => undefined, signal: undefined as AbortSignal | undefined };
    respond = async call => {
        if (call.args[0] !== 'run') return { stdout: '', stderr: 'Error: No such container: claude-issue-1-abc', exitCode: 1, messageTimestamps: new Map() };
        state.signal = call.options.signal;
        await new Promise<void>(resolve => { state.release = resolve; });
        if (call.options.signal?.aborted) throw call.options.signal.reason;
        state.spawned = true;
        call.options.agentRun.onSpawn();
        return { stdout: 'worked', stderr: '', exitCode: 0, messageTimestamps: new Map() };
    };
    return state;
}

test('stop during pending launch preparation cancels the launch instead of trusting container absence', async () => {
    calls.length = 0;
    const launch = pendingLaunch();
    const handle = new DockerRuntime().start(spec(), { timeout: 1000 });
    const outcome = handle.wait().then(() => 'resolved', error => error);
    await new Promise(resolve => setImmediate(resolve));
    let stopped = false;
    const stopping = handle.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(launch.signal?.aborted, true, 'the cancellation reaches launch preparation');
    assert.equal(stopped, false, 'stop does not succeed while the launch could still start');
    launch.release();
    await stopping;
    assert.equal(launch.spawned, false, 'the pending launch never starts the agent');
    assert.ok(await outcome instanceof AgentRunStoppedError);
    assert.equal(calls.filter(call => call.args[0] === 'stop').length, 0);
});

test('stop after spawn whose container Docker does not know yet also cancels the launch', async () => {
    calls.length = 0;
    let release!: () => void;
    let signal: AbortSignal | undefined;
    respond = async call => {
        if (call.args[0] !== 'run') return { stdout: '', stderr: 'Error: No such container: claude-issue-1-abc', exitCode: 1, messageTimestamps: new Map() };
        signal = call.options.signal;
        call.options.agentRun.onSpawn();
        await new Promise<void>(resolve => { release = resolve; });
        if (signal?.aborted) throw signal.reason;
        return { stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() };
    };
    const handle = new DockerRuntime().start(spec(), { timeout: 1000 });
    const outcome = handle.wait().then(() => 'resolved', error => error);
    await new Promise(resolve => setImmediate(resolve));
    const stopping = handle.stop('SIGTERM', 1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.at(-1)!.args.slice(0, 1), ['stop']);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal?.aborted, true);
    release();
    await stopping;
    assert.ok(await outcome instanceof AgentRunStoppedError);
});

test('a caller signal still reaches the launch alongside the handle cancellation', async () => {
    calls.length = 0;
    const launch = pendingLaunch();
    const caller = new AbortController();
    const handle = new DockerRuntime().start(spec(), { timeout: 1000, signal: caller.signal });
    const outcome = handle.wait().then(() => 'resolved', error => error);
    await new Promise(resolve => setImmediate(resolve));
    caller.abort(new Error('caller cancelled'));
    assert.equal(launch.signal?.aborted, true);
    launch.release();
    assert.match(String(await outcome), /caller cancelled/);
});

test('specs needing capabilities a runtime lacks are refused', () => {
    const run = spec();
    const noBinds = { kind: 'remote', capabilities: { supportsBindMounts: false, supportsRestrictedNetwork: true, supportsMcpPrivateNetwork: true, reattach: true }, start: () => { throw new Error('unused'); } };
    assert.throws(() => assertAgentRuntimeSupports(noBinds as any, run), /cannot bind-mount/);
    const noMcp = { ...noBinds, capabilities: { ...noBinds.capabilities, supportsBindMounts: true, supportsMcpPrivateNetwork: false } };
    assert.doesNotThrow(() => assertAgentRuntimeSupports(noMcp as any, run));
    assert.throws(() => assertAgentRuntimeSupports(noMcp as any, { ...run, mcpGrant: { servers: ['propr'], network: 'propr_default' } }), /cannot join MCP network/);
    const noRestriction = { ...noBinds, capabilities: { ...noBinds.capabilities, supportsBindMounts: true, supportsRestrictedNetwork: false } };
    assert.doesNotThrow(() => assertAgentRuntimeSupports(noRestriction as any, run));
    const restricted = { ...run, network: { ...run.network, restriction: { mode: 'restricted' as const, source: 'instance_enforced' as const, allow: [] } } };
    assert.throws(() => assertAgentRuntimeSupports(noRestriction as any, restricted), /cannot enforce the restricted network policy \(instance_enforced\)/);
});

/** A runtime with bind mounts but chosen restricted-network support, recording what it was asked to start. */
function recordingRuntime(kind: string, supportsRestrictedNetwork: boolean) {
    const started: any[] = [];
    registerAgentRuntime(kind, () => ({
        kind,
        capabilities: { supportsBindMounts: true, supportsRestrictedNetwork, supportsMcpPrivateNetwork: true, reattach: false },
        start: (runSpec: any) => {
            started.push(runSpec);
            return { wait: async () => ({ stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() }) } as any;
        },
    }));
    return started;
}

const restrictedPolicy = { mode: 'restricted' as const, source: 'workflow' as const, allow: ['registry.npmjs.org'] };
const enforcedPolicy = { mode: 'restricted' as const, source: 'instance_enforced' as const, allow: [] };

test('a runtime without restricted networking is refused before launch under a restricted run policy', async () => {
    const started = recordingRuntime('open-only', false);
    await assert.rejects(executeWithNetworkPolicy(restrictedPolicy, () => runAgent({ runtime: 'open-only' }, spec(), {})), /"open-only" cannot enforce the restricted network policy/);
    assert.equal(started.length, 0);
    await executeWithNetworkPolicy({ mode: 'open', source: 'instance', allow: [] }, () => runAgent({ runtime: 'open-only' }, spec(), {}));
    assert.equal(started.length, 1, 'open runs are unaffected');
    assert.equal(started[0].network.restriction, undefined);
});

test('the enforced instance policy applies to runs started outside any run policy', async () => {
    const started = recordingRuntime('open-only-unscoped', false);
    setUnscopedNetworkPolicyResolver(async () => enforcedPolicy);
    try {
        await assert.rejects(runAgent({ runtime: 'open-only-unscoped' }, spec(), {}), /cannot enforce the restricted network policy \(instance_enforced\)/);
        assert.equal(started.length, 0);
        setUnscopedNetworkPolicyResolver(async () => { throw new Error('settings unreadable'); });
        await assert.rejects(runAgent({ runtime: 'open-only-unscoped' }, spec(), {}), /settings unreadable/, 'an unreadable policy fails closed');
        setUnscopedNetworkPolicyResolver(async () => ({ mode: 'restricted', source: 'instance', allow: [] }));
        await runAgent({ runtime: 'open-only-unscoped' }, spec(), {});
        assert.equal(started.length, 1, 'a non-enforced instance default does not bind unscoped runs');
    } finally {
        setUnscopedNetworkPolicyResolver(undefined);
    }
});

test('supporting runtimes receive the resolved restriction; Docker argv is unchanged', async () => {
    const started = recordingRuntime('restricting', true);
    await executeWithNetworkPolicy(restrictedPolicy, () => runAgent({ runtime: 'restricting' }, spec(), {}));
    assert.deepEqual(started[0].network.restriction, restrictedPolicy);
    calls.length = 0;
    respond = async () => ({ stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() });
    const run = spec();
    await executeWithNetworkPolicy(restrictedPolicy, () => runAgent(null, run, {}));
    assert.deepEqual(calls[0].options.agentRun.spec.network.restriction, restrictedPolicy);
    assert.deepEqual(calls[0].args, renderDockerRunArgs(run));
    assert.equal(run.network.restriction, undefined, 'the provider spec is not mutated');
    calls.length = 0;
    await executeWithNetworkPolicy(restrictedPolicy, () => runAgent(null, spec(), { networkPolicyExempt: 'ProPR-owned probe' }));
    assert.equal(calls[0].options.agentRun.spec.network.restriction, undefined);
});

test('an explicit spec restriction is kept, never replaced by the applying policy before dispatch', async () => {
    const started = recordingRuntime('restricting-explicit', true);
    const own = { mode: 'restricted' as const, source: 'workflow' as const, allow: ['registry.npmjs.org'] };
    const withOwn = () => { const run = spec(); return { ...run, network: { ...run.network, restriction: own } }; };
    await runAgent({ runtime: 'restricting-explicit' }, withOwn(), {});
    assert.equal(started[0].network.restriction, own, 'kept when no policy applies');
    const enclosing = { mode: 'restricted' as const, source: 'workflow' as const, allow: ['example.com'] };
    await assert.rejects(executeWithNetworkPolicy(enclosing, () => runAgent({ runtime: 'restricting-explicit' }, withOwn(), {})),
        /carries a restricted network policy \(workflow\) that differs from the policy applying at launch \(workflow\)/);
    await assert.rejects(executeWithNetworkPolicy(enclosing, () => runAgent({ runtime: 'restricting-explicit' }, withOwn(), { networkPolicyExempt: 'probe' })),
        /differs from the policy applying at launch/);
    setUnscopedNetworkPolicyResolver(async () => ({ ...enforcedPolicy, allow: ['example.com'] }));
    try {
        await assert.rejects(runAgent({ runtime: 'restricting-explicit' }, withOwn(), {}), /differs from the policy applying at launch \(instance_enforced\)/);
    } finally {
        setUnscopedNetworkPolicyResolver(undefined);
    }
    assert.equal(started.length, 1, 'conflicting runs never reach the runtime');
    await executeWithNetworkPolicy({ ...own, allow: [...own.allow] }, () => runAgent({ runtime: 'restricting-explicit' }, withOwn(), {}));
    assert.equal(started[1].network.restriction, own, 'a matching policy keeps the spec restriction');
});

test('native goals resolve the runtime selection and refuse anything but Docker', () => {
    assert.doesNotThrow(() => assertNativeGoalRuntime(undefined, {}));
    assert.doesNotThrow(() => assertNativeGoalRuntime({ runtime: 'docker' }, { [AGENT_RUNTIME_ENV]: 'docker' }));
    recordingRuntime('goal-remote', true);
    assert.throws(() => assertNativeGoalRuntime({ runtime: 'goal-remote' }, {}), /support only the "docker" agent runtime; "goal-remote" is selected/);
    assert.throws(() => assertNativeGoalRuntime(undefined, { [AGENT_RUNTIME_ENV]: 'goal-remote' }), /"goal-remote" is selected/);
    assert.throws(() => assertNativeGoalRuntime(undefined, { [AGENT_RUNTIME_ENV]: 'sprites' }), /Unknown agent runtime "sprites"/);
});

function cloneSpec() {
    const run = spec();
    run.repoSetup = { agentType: 'claude', shell: '/bin/bash', script: 'SETUP', providerEntrypoint: '/home/node/claude-entrypoint.sh', env: [] };
    return {
        ...run,
        mounts: [],
        workspace: {
            ...run.workspace, mode: 'clone' as const,
            clone: {
                remote: 'https://github.com/acme/widgets.git', baseRef: 'refs/propr/runs/r/base', baseCommit: 'a'.repeat(40), branch: 'task-1',
                resultRef: 'refs/propr/runs/r/result', resultDir: '/tmp/propr-workspace-result', script: 'TRANSPORT',
            },
        },
    };
}

test('a clone-mode spec renders the transport wrapper outside the setup wrapper and keeps the container', () => {
    const args = renderDockerRunArgs(cloneSpec());
    assert.ok(!args.includes('--rm'), 'the finished container is kept so its result files can be read');
    assert.ok(renderDockerRunArgs(spec()).includes('--rm'), 'bind mode is unchanged');
    const image = args.indexOf('propr/agent:test');
    assert.deepEqual(args.slice(image - 2, image + 6), ['--entrypoint', '/bin/bash', 'propr/agent:test', '-lc', 'TRANSPORT', 'SETUP', '/home/node/claude-entrypoint.sh', 'claude']);
    assert.ok(!args.some(arg => arg.includes('/tmp/w:')), 'the worktree is not mounted');
    const { repoSetup: _repoSetup, ...direct } = cloneSpec();
    assert.throws(() => renderDockerRunArgs(direct), /needs an explicit entrypoint/);
    // No setup wrapper drops a direct entrypoint's privileges: the transport wrapper starts it as the agent user.
    assert.deepEqual(renderDockerRunArgs({ ...direct, entrypoint: '/entry' }).slice(-10),
        ['--entrypoint', '/bin/bash', 'propr/agent:test', '-lc', 'TRANSPORT', 'propr-workspace-transport:run-as-agent', '/entry', 'claude', '-p', '-']);
    // A provider entrypoint started as root drops to the agent only to run a command; without one it opens a root shell.
    assert.throws(() => renderDockerRunArgs({ ...cloneSpec(), args: [] }), /gives its provider entrypoint no command to run as the agent user/);
    assert.doesNotThrow(() => renderDockerRunArgs({ ...spec(), args: [] }), 'bind mode is unchanged');
    assert.throws(() => renderDockerRunArgs({ ...spec(), workspace: { ...spec().workspace, mode: 'clone' } }), /was not prepared by it/);
    // The credential-holding wrapper never shares the agent's user ID.
    for (const user of [undefined, '1000:1000', 'node']) {
        assert.throws(() => renderDockerRunArgs({ ...cloneSpec(), user }), /uses the clone workspace transport but does not start as root/);
    }
    assert.doesNotThrow(() => renderDockerRunArgs({ ...cloneSpec(), user: 'root' }));
});

test('docker clone-mode handles remove their kept container on release; bind handles have nothing to release', async () => {
    calls.length = 0;
    respond = async () => ({ stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() });
    const handle = new DockerRuntime().start(cloneSpec(), { extraEnvVars: { PROPR_WORKSPACE_GIT_TOKEN: 'secret' } });
    await handle.wait();
    assert.equal(calls[0].options.extraEnvVars.PROPR_WORKSPACE_GIT_TOKEN, 'secret', 'the token reaches the docker client environment, not argv');
    assert.ok(!calls[0].args.some((arg: string) => arg.includes('secret')));
    await handle.release!();
    await handle.release!();
    assert.deepEqual(calls.slice(1).map(call => call.args), [['rm', '-f', 'claude-issue-1-abc']]);
    assert.equal(await handle.readFile!('/tmp/propr-workspace-result/status'), null, 'a released run has no files');

    calls.length = 0;
    const bound = new DockerRuntime().start(spec(), {});
    await bound.wait();
    await bound.release!();
    assert.equal(await bound.readFile!('/x'), null);
    assert.equal(calls.length, 1, 'a --rm run needs no removal');
});

test('clone mode is refused on runtimes that cannot run it and for native goal sessions', async () => {
    const bindOnly = { kind: 'bind-only', capabilities: { supportsBindMounts: true, supportsRestrictedNetwork: true, supportsMcpPrivateNetwork: true, reattach: false }, start: () => { throw new Error('unused'); } };
    assert.throws(() => assertAgentRuntimeSupports(bindOnly as any, cloneSpec()), /cannot run the "clone" workspace transport/);
    assert.doesNotThrow(() => assertAgentRuntimeSupports(new DockerRuntime() as any, cloneSpec()));
    const started = recordingRuntime('bind-only', true);
    const previous = process.env.PROPR_WORKSPACE_TRANSPORT;
    process.env.PROPR_WORKSPACE_TRANSPORT = 'clone';
    try {
        await assert.rejects(runAgent({ runtime: 'bind-only' }, spec(), {}), /"bind-only" cannot run the "clone" workspace transport/);
        assert.equal(started.length, 0, 'refused before anything is published or minted');
    } finally {
        if (previous === undefined) delete process.env.PROPR_WORKSPACE_TRANSPORT; else process.env.PROPR_WORKSPACE_TRANSPORT = previous;
    }
    assert.throws(() => assertNativeGoalRuntime(undefined, { PROPR_WORKSPACE_TRANSPORT: 'clone' }), /only the "bind" workspace transport/);
    assert.doesNotThrow(() => assertNativeGoalRuntime(undefined, { PROPR_WORKSPACE_TRANSPORT: 'bind' }));
});

test('a read-only run dispatched under PROPR_WORKSPACE_TRANSPORT=clone is refused before it starts', async () => {
    const started: any[] = [];
    registerAgentRuntime('clone-capable', () => ({
        kind: 'clone-capable',
        capabilities: { supportsBindMounts: true, supportsRestrictedNetwork: true, supportsMcpPrivateNetwork: true, reattach: false, workspaceTransports: ['bind', 'clone'] },
        start: (runSpec: any) => { started.push(runSpec); throw new Error('must not start'); },
    }) as any);
    const readOnly = spec();
    readOnly.workspace.readOnly = true;
    const previous = process.env.PROPR_WORKSPACE_TRANSPORT;
    process.env.PROPR_WORKSPACE_TRANSPORT = 'clone';
    try {
        await assert.rejects(runAgent({ runtime: 'clone-capable' }, readOnly, {}), /cannot enforce a read-only workspace for claude-issue-1-abc; run it with the bind transport/);
        assert.equal(started.length, 0);
    } finally {
        if (previous === undefined) delete process.env.PROPR_WORKSPACE_TRANSPORT; else process.env.PROPR_WORKSPACE_TRANSPORT = previous;
    }
});

test('the runtime file API extracts the single file docker cp streams as tar', async () => {
    const { extractSingleFileFromTar } = await import('../packages/core/src/agents/runtime/dockerContainerFiles.ts');
    const header = Buffer.alloc(512);
    header.write('status', 0);
    header.write('0000644\0', 100);
    header.write(`${(12).toString(8).padStart(11, '0')}\0`, 124);
    header.write('0', 156);
    const body = Buffer.alloc(512);
    body.write('pushed abcd\n');
    assert.equal(extractSingleFileFromTar(Buffer.concat([header, body, Buffer.alloc(1024)]))?.toString(), 'pushed abcd\n');
    assert.equal(extractSingleFileFromTar(Buffer.alloc(1024)), null);
    assert.throws(() => extractSingleFileFromTar(Buffer.concat([header, Buffer.alloc(4)])), /Truncated/);
});

const { UNRELEASED_RUN_REMOVAL_MS } = await import('../packages/core/src/agents/runtime/dockerRuntime.ts');

function removals(): string[][] {
    return calls.filter(call => call.args[0] === 'rm').map(call => call.args);
}

test('an unreleased clone-mode container is removed when its timer expires, unless the run is retained', async t => {
    respond = async () => ({ stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    calls.length = 0;
    const expiring = new DockerRuntime().start(cloneSpec());
    await expiring.wait();
    await Promise.resolve();
    t.mock.timers.tick(UNRELEASED_RUN_REMOVAL_MS);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(removals(), [['rm', '-f', 'claude-issue-1-abc']], 'nothing released it, so the timer removes it');

    calls.length = 0;
    const retained = new DockerRuntime().start(cloneSpec());
    await retained.wait();
    await Promise.resolve();
    retained.retain!();
    retained.retain!();
    t.mock.timers.tick(UNRELEASED_RUN_REMOVAL_MS * 3);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(removals(), [], 'a retained run outlives the removal timer');
    await retained.release!();
    assert.deepEqual(removals(), [['rm', '-f', 'claude-issue-1-abc']], 'an explicit release still removes it');

    calls.length = 0;
    const bound = new DockerRuntime().start(spec());
    await bound.wait();
    bound.retain!();
    await bound.release!();
    assert.deepEqual(removals(), [], 'a --rm run has nothing to retain or remove');
});

test('a failed bundle retrieval keeps the docker run past its removal timer, so the only result copy survives', async t => {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { CloneWorkspaceTransport } = await import('../packages/core/src/git/workspaceCloneTransport.ts');
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-docker-retain-'));
    const remote = path.join(root, 'remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    const worktree = path.join(root, 'worktree');
    git(root, 'init', '-q', '-b', 'task-1', worktree);
    fs.writeFileSync(path.join(worktree, 'a.txt'), 'a\n');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'base');
    git(worktree, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    const revoked: string[] = [];
    const transport = new CloneWorkspaceTransport({
        mintToken: async () => 'ghs_retain', revokeToken: async token => { revoked.push(token); },
        workerToken: async () => undefined, remoteUrl: () => remote, createRunId: () => 'run-1',
    });
    const run = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent:test', name: 'claude-issue-1-abc', stdin: true, user: '0:0',
        network: agentRunNetwork('bridge'), workspace: { hostPath: worktree, containerPath: '/home/node/workspace', readOnly: false },
    }).workspaceMount().command('claude', '-p', '-').build();
    run.repoSetup = { agentType: 'claude', shell: '/bin/bash', script: 'SETUP', providerEntrypoint: '/home/node/claude-entrypoint.sh', env: [] };
    const prepared = await transport.prepare(run);

    respond = async () => ({ stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() });
    calls.length = 0;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const docker = new DockerRuntime().start(prepared.spec, { extraEnvVars: { ...prepared.launchEnvironment } });
    const result = await docker.wait();
    // The sandbox could not push and left a bundle; `docker cp` of that bundle then fails.
    const handle = {
        spec: docker.spec, stdout: docker.stdout, stderr: docker.stderr,
        wait: () => docker.wait(), stop: () => docker.stop(), inspect: () => docker.inspect(), isAlive: () => docker.isAlive(),
        readFile: async (file: string) => {
            if (file.endsWith('/status')) return Buffer.from(`bundle ${'b'.repeat(40)}\n`);
            throw new Error(`docker cp claude-issue-1-abc:${file} failed: connection reset`);
        },
        release: () => docker.release!(), retain: () => docker.retain!(),
    };
    await assert.rejects(prepared.complete(handle, result), /returned no workspace result.*kept for recovery at the kept run claude-issue-1-abc/);
    // The removal timer installed when the run settled expires (well past its delay).
    t.mock.timers.tick(UNRELEASED_RUN_REMOVAL_MS * 3);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(removals(), [], 'the container holding the only bundle outlives its removal timer');
    // Cleanup's git commands run on real timers.
    t.mock.timers.reset();
    await prepared.cleanup(handle).catch(() => undefined);
    assert.deepEqual(removals(), [], 'cleanup does not release the container holding the only bundle');
    assert.deepEqual(revoked, ['ghs_retain'], 'the token is still revoked');
    assert.equal(git(root, 'ls-remote', remote, 'refs/propr/*'), '', 'the base ref is deleted');
    fs.rmSync(root, { recursive: true, force: true });
});
