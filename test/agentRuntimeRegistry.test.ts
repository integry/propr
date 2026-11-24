import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

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

const { getAgentRuntime, registerAgentRuntime, resolveAgentRuntimeKind, runAgent, assertAgentRuntimeSupports, AGENT_RUNTIME_ENV } = await import('../packages/core/src/agents/runtime/registry.ts');
const { DockerRuntime } = await import('../packages/core/src/agents/runtime/dockerRuntime.ts');
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
    await handle.stop('SIGINT', 5000);
    assert.deepEqual(calls.at(-1)!.args, ['stop', '--signal', 'SIGINT', '--time', '5', 'claude-issue-1-abc']);
    release();
    assert.equal((await handle.wait()).stdout, 'hello world');
    await new Promise(resolve => handle.stdout.once('end', resolve));
    assert.equal(chunks.join(''), 'world', 'output emitted before the stream was first read is not buffered');
    assert.equal(stderr.join(''), 'warn');

    respond = async () => ({ stdout: '', stderr: 'Error: No such container: claude-issue-1-abc', exitCode: 1, messageTimestamps: new Map() });
    assert.equal((await handle.inspect()).liveness, 'not_found');
    await handle.stop();
});

test('specs needing capabilities a runtime lacks are refused', () => {
    const run = spec();
    const noBinds = { kind: 'remote', capabilities: { supportsBindMounts: false, supportsRestrictedNetwork: true, supportsMcpPrivateNetwork: true, reattach: true }, start: () => { throw new Error('unused'); } };
    assert.throws(() => assertAgentRuntimeSupports(noBinds as any, run), /cannot bind-mount/);
    const noMcp = { ...noBinds, capabilities: { ...noBinds.capabilities, supportsBindMounts: true, supportsMcpPrivateNetwork: false } };
    assert.doesNotThrow(() => assertAgentRuntimeSupports(noMcp as any, run));
    assert.throws(() => assertAgentRuntimeSupports(noMcp as any, { ...run, mcpGrant: { servers: ['propr'], network: 'propr_default' } }), /cannot join MCP network/);
});
