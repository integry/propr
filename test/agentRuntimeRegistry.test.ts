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
    assert.equal(calls[0].options.agentRun.spec, run);
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

test('handle stop, inspect and isAlive address the Docker daemon the run was launched on', async () => {
    calls.length = 0;
    let release!: () => void;
    respond = async call => {
        if (call.args[0] === 'run') {
            call.options.agentRun.onSpawn();
            await new Promise<void>(resolve => { release = resolve; });
            return { stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() };
        }
        if (call.args[0] === 'inspect') {
            // Only the launch daemon knows the run; the default daemon reports it absent.
            return call.options.extraEnvVars?.DOCKER_HOST === 'tcp://daemon-b:2376'
                ? { stdout: 'abc123 running\n', stderr: '', exitCode: 0, messageTimestamps: new Map() }
                : { stdout: '', stderr: 'Error: No such container: claude-issue-1-abc', exitCode: 1, messageTimestamps: new Map() };
        }
        return { stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() };
    };
    const launchEnv: Record<string, string> = { DOCKER_HOST: 'tcp://daemon-b:2376', DOCKER_TLS_VERIFY: '1', POLICY_TOKEN: 't' };
    const handle = new DockerRuntime().start(spec(), { extraEnvVars: launchEnv });
    // A caller reusing its options object afterwards does not retarget the handle.
    launchEnv.DOCKER_HOST = 'tcp://elsewhere:2376';
    await new Promise(resolve => setImmediate(resolve));
    const expected = { DOCKER_HOST: 'tcp://daemon-b:2376', DOCKER_TLS_VERIFY: '1', POLICY_TOKEN: 't' };
    assert.deepEqual(calls[0].options.extraEnvVars, launchEnv, 'the launch itself sees the caller environment');

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
    release();
    await stopping;
});

test('handle control commands keep the default Docker environment when the launch had none', async () => {
    calls.length = 0;
    respond = async call => {
        if (call.args[0] === 'run') return new Promise(() => undefined);
        return { stdout: 'abc123 running\n', stderr: '', exitCode: 0, messageTimestamps: new Map() };
    };
    const handle = new DockerRuntime().start(spec(), { extraEnvVars: {} });
    await handle.inspect();
    assert.equal('extraEnvVars' in calls.at(-1)!.options, false);
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
