import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { text } from 'node:stream/consumers';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { configuredExtensionRefusal, getAgentRuntime } from '../packages/core/src/agents/runtime/registry.ts';
import { agentRunMcpTransportFor } from '../packages/core/src/agents/runtime/agentRunMcpTransport.ts';
import { dockerAgentRuntimeInUse } from '../packages/core/src/agents/runtime/runtimeSelection.ts';
import type { MachineLaunch, MachinesApi } from '../packages/core/src/agents/runtime/fly/api.ts';
import { RUN, wrapper } from '../packages/core/src/agents/runtime/fly/wrapper.ts';
import { WORKSPACE_TRANSPORT_RESULT_DIR as RESULT, WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import { buildAgentRunRepoSetup } from '../packages/core/src/claude/docker/repoSetupWrapper.ts';
import { executeWithRepositoryWorkflow, repositoryWorkflowExecution } from '../packages/core/src/workflow/workflowExecution.ts';
import { runWithActiveRunCostCap } from '../packages/core/src/budget/runCostGuardContext.ts';
import { closeConnection } from '../packages/core/src/db/connection.ts';
after(closeConnection);

const token = 'FlyV1 synthetic-worker-credential';
const env = { PROPR_FLY_APP: 'agents', PROPR_FLY_API_TOKEN: token, PROPR_FLY_IMAGE: 'registry.fly.io/agents@sha256:test' };

class FakeMachines implements MachinesApi {
    launch?: MachineLaunch;
    files = new Map<string, Buffer>([
        [RUN + '/stdout', Buffer.from('authoritative ' + token + '\n')],
        [RUN + '/stderr', Buffer.alloc(0)],
        [RUN + '/workspace/status', Buffer.from('bundle test')],
        [RUN + '/workspace/result.bundle', Buffer.from([0, 255, 42])],
    ]);
    status = 'exited 0';
    probing = Promise.withResolvers<void>();
    destroyed = 0;
    signals: NodeJS.Signals[] = [];
    ignoreStop = false;
    failedRead?: string;
    async create(launch: MachineLaunch) { this.launch = launch; return 'machine'; }
    async logs(_id: string, publish: (message: string) => void) {
        publish('propr-stdout ' + JSON.stringify('display only ' + token));
        throw new Error('lost log connection');
    }
    async exec(_id: string, args: string[]) {
        assert.equal(this.destroyed, 0, 'all guest files must be collected before destroy');
        const [op, file, offset, length] = args.slice(3);
        if (op === 'probe') {
            this.probing.resolve();
            return { stdout: this.status + '\n123\n', exit_code: 0 };
        }
        const data = this.files.get(file);
        if (op === 'size') return { stdout: String(data?.length), exit_code: data ? 0 : 44 };
        assert.equal(op, 'chunk');
        if (this.failedRead === file) throw new Error('read failed');
        return { stdout: data!.subarray(+offset, +offset + +length).toString('base64'), exit_code: 0 };
    }
    async signal(_id: string, signal: NodeJS.Signals) {
        this.signals.push(signal);
        if (!this.ignoreStop) this.status = 'exited 143';
    }
    async destroy() { this.destroyed++; }
}
function fixture() {
    const api = new FakeMachines();
    const runtime = new FlyMachinesRuntime(api, env);
    const builder = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent', name: 'task', stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote: 'unused', baseRef: 'base', baseCommit: '0123', branch: 'test', resultDir: RESULT, script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('claude', '--version');
    return { api, runtime, builder };
}

test('only capture files feed the result, the Fly credential stays off the guest and out of both streams', async () => {
    const { runtime, api, builder } = fixture();
    builder.env('PROPR_FLY_API_TOKEN', token).env('ALIAS', token).env('GH_TOKEN', 'test-github-secret');
    const run = runtime.start(builder.build());
    const displayed = text(run.stdout);
    const result = await run.wait();
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'authoritative [REDACTED]\n');
    assert.equal(await displayed, 'display only [REDACTED]\n');
    assert.equal(result.stderr, '');
    assert.equal(api.destroyed, 1);
    assert.equal(api.launch?.config.auto_destroy, true);
    assert.equal(api.launch?.config.restart.policy, 'no');
    assert.equal(api.launch?.config.processes[0].user, 'root');
    assert.ok(api.launch?.config.processes[0].entrypoint.length);
    assert.ok(api.launch?.config.processes[0].cmd.length);
    assert.ok(!JSON.stringify(api.launch).includes(token));
    for (const file of api.launch!.config.files) assert.ok(!Buffer.from(file.raw_value, 'base64').includes(token));
    assert.deepEqual(await run.readFile!(RESULT + '/result.bundle'), Buffer.from([0, 255, 42]));
    await Promise.all([run.release!(), run.release!()]);
    assert.equal(await run.readFile!(RESULT + '/status'), null);
    assert.equal(api.destroyed, 1);
});

test('a failed authoritative stream read fails even after an exited 0', async () => {
    const { runtime, api, builder } = fixture();
    api.failedRead = RUN + '/stdout';
    const run = runtime.start(builder.build());
    const result = await run.wait();
    assert.equal(result.exitCode, -1);
    assert.match(result.outputIncomplete!, /output unavailable: stdout/);
    assert.equal(result.stdout, '');
    await run.release!();
});

test('graceful stop gives 143 and copies the bundle before destroying the Machine', async () => {
    const { runtime, api, builder } = fixture();
    api.status = 'running';
    const run = runtime.start(builder.build());
    await api.probing.promise;
    await run.stop('SIGTERM', 5000);
    assert.equal((await run.wait()).exitCode, 143);
    assert.deepEqual(api.signals, ['SIGTERM']);
    assert.equal(api.destroyed, 1);
    assert.deepEqual(await run.readFile!(RESULT + '/result.bundle'), Buffer.from([0, 255, 42]));
    await run.release!();
});

test('release stops a running Machine and forced stop destroys one that ignores the signal', async () => {
    for (const force of [true, false]) {
        const { runtime, api, builder } = fixture();
        api.status = 'running';
        api.ignoreStop = force;
        const run = runtime.start(builder.build());
        await api.probing.promise;
        if (force) {
            await run.stop('SIGINT', 1);
            assert.deepEqual(api.signals, ['SIGINT', 'SIGKILL']);
            assert.match((await run.wait()).outputIncomplete!, /status/);
        }
        await run.release!();
        assert.equal(api.destroyed, 1);
    }
});

test('wrapper publishes each whole status with fsync followed by same-directory rename', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-status-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('python3', ['-I', '-c', wrapper + `
from unittest.mock import patch
run = Path(sys.argv[2])
for value in ('running', 'exited 143'):
    with patch('os.fsync', wraps=os.fsync) as synced, patch('os.replace', wraps=os.replace) as renamed:
        def rename(src, dst):
            synced.assert_called_once()
            assert src.parent == dst.parent == run and dst.name == 'status'
            assert src.read_text() == value + '\\n'
            os.rename(src, dst)
        renamed.side_effect = rename
        status(value)
        renamed.assert_called_once()
        assert (run / 'status').read_text() == value + '\\n'
`, 'test', root]);
});

test('Fly selection skips Docker preparation, refuses extensions and restricted networks, and resolves MCP', () => {
    const { runtime, builder } = fixture();
    assert.equal(getAgentRuntime({ runtime: 'fly-machines' }).kind, runtime.kind);
    assert.equal(dockerAgentRuntimeInUse([], { PROPR_AGENT_RUNTIME: runtime.kind }), false);
    assert.match(configuredExtensionRefusal(runtime.kind)!, /does not support extensions/);
    builder.spec.network.policy = { mode: 'restricted', allow: [], privateAddressAllow: [] };
    assert.throws(() => runtime.start(builder.build()), /open networking/);
    const plan = (env: NodeJS.ProcessEnv) => agentRunMcpTransportFor({ runtime: runtime.kind }, env);
    assert.match(JSON.stringify(plan({ FLY_APP_NAME: 'control', FLY_PRIVATE_IP: 'fd00::1' })), /control\.internal:4000/);
    assert.match(JSON.stringify(plan({ API_PUBLIC_URL: 'https://mcp.example' })), /https:\/\/mcp.example\/api\/mcp/);
});

test('a hook failure outside the retained stderr tail still fails the workflow', async () => {
    const { runtime, api, builder } = fixture();
    const result = await executeWithRepositoryWorkflow({ revision: 'base', fileRevision: 'blob', baseBranch: 'main',
        config: { hooks: { before_run: 'exit 7' } }, timeoutMs: 1000, maxParallelTasks: 1 }, async () => {
        const marker = repositoryWorkflowExecution.getStore()!.marker;
        api.files.set(RUN + '/stderr', Buffer.from('\n' + marker + ':hook:before_run:7\n' + 'other output\n'.repeat(100000)));
        builder.spec.repoSetup = buildAgentRunRepoSetup('claude');
        const run = runtime.start(builder.build());
        assert.equal((await run.wait()).exitCode, 0);
        await run.release!();
        return { success: true, modifiedFiles: [], logs: '', modelUsed: 'test', executionTimeMs: 0 };
    });
    assert.equal(result.success, false);
    assert.match(result.error!, /before_run failed with exit code 7/);
});

test('the shared cost guard observes each captured record once and ignores live records', async () => {
    const { runtime, builder, api } = fixture();
    const observed: string[] = [];
    api.files.set(RUN + '/stdout', Buffer.from('first\nlast'));
    await runWithActiveRunCostCap({
        taskId: 'task', exceeded: false, admit: async () => {},
        beginExecution: () => ({ observeLine: line => observed.push(line), finish: async () => 'run reached its cost cap' }),
    }, async () => {
        const run = runtime.start(builder.build(), { preserveOutputOnTimeout: true });
        const result = await run.wait();
        assert.equal(result.costCapExceeded, true);
        assert.deepEqual(observed, ['first', 'last']);
        await run.release!();
    });
});

test('per-run provider files round-trip through the credential broker', async t => {
    const { runtime, builder, api } = fixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-credential-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const name = '.credentials.json';
    const original = '{"accessToken":"synthetic-original"}';
    const updated = '{"accessToken":"synthetic-refresh"}';
    fs.writeFileSync(path.join(root, name), original);
    fs.writeFileSync(path.join(root, 'unrelated'), 'private');
    builder.credentialBind(root, '/home/node/.claude', false, { provider: 'claude', store: 'config', perRun: true });
    const exec = api.exec.bind(api);
    api.exec = async (id, args) => {
        if (args[0] !== 'su-exec') return exec(id, args);
        assert.equal(args[1], 'node');
        assert.equal(args.at(-1), '/home/node/.claude/' + name);
        return { exit_code: 0, stdout: JSON.stringify([Date.now(), Buffer.from(updated).toString('base64')]) };
    };
    const run = runtime.start(builder.build());
    await run.wait();
    const files = api.launch!.config.files;
    assert.ok(!files.some(f => f.guest_path.endsWith('unrelated')));
    assert.equal(Buffer.from(files.find(f => f.guest_path.endsWith('/' + name))!.raw_value, 'base64').toString(), original);
    assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), updated);
    assert.equal(api.destroyed, 1);
    await run.release!();
});

test('settlement rejection reports the collected bundle and preserves it through cleanup', async t => {
    for (const failure of ['destroy', 'callback']) {
        const { runtime, builder, api } = fixture();
        const destroying = Promise.withResolvers<void>();
        const proceed = Promise.withResolvers<void>();
        let attempts = 0;
        api.destroy = async () => {
            if (++attempts === 1) {
                destroying.resolve();
                await proceed.promise;
                if (failure === 'destroy') throw new Error('delete failed');
            }
            api.destroyed++;
        };
        api.files.set(RUN + '/stdout', Buffer.from('{"session_id":"id"}\n'));
        const run = runtime.start(builder.build(), {
            onSessionId: () => { if (failure === 'callback') throw new Error('callback failed'); },
        });
        await destroying.promise;
        const cleanup = Promise.all([run.stop(), run.release!()]);
        proceed.resolve();
        await assert.rejects(run.wait(), (error: Error) => {
            assert.match(error.message, failure === 'destroy' ? /delete failed/ : /callback failed/);
            assert.ok(run.recoveryLocation);
            assert.ok(error.message.includes(run.recoveryLocation));
            return true;
        });
        await cleanup;
        const directory = run.recoveryLocation!;
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        assert.deepEqual(fs.readFileSync(path.join(directory, 'result.bundle')), Buffer.from([0, 255, 42]));
        assert.equal(api.destroyed, 1);
    }
});

test('cancellation between wait and workspace return keeps the collected bundle', async t => {
    const { runtime, builder } = fixture();
    const controller = new AbortController();
    const run = runtime.start(builder.build(), { signal: controller.signal });
    await run.wait();
    controller.abort();
    await run.release!();
    const directory = run.recoveryLocation!;
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    assert.deepEqual(fs.readFileSync(path.join(directory, 'result.bundle')), Buffer.from([0, 255, 42]));
});

test('credential export and canonical write failures retain the Machine through concurrent cleanup', async t => {
    for (const failure of ['export', 'invalid response', 'commit']) {
        const { runtime, builder, api } = fixture();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-credential-test-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const name = '.credentials.json';
        fs.writeFileSync(path.join(root, name), 'original');
        builder.credentialBind(root, '/home/node/.claude', false, { provider: 'claude', store: 'config', perRun: true });
        api.files.set(RUN + '/workspace/status', Buffer.from('pushed commit'));
        api.files.delete(RUN + '/workspace/result.bundle');
        const exporting = Promise.withResolvers<void>();
        const proceed = Promise.withResolvers<void>();
        const exec = api.exec.bind(api);
        api.exec = async (id, args) => {
            if (args[0] !== 'su-exec') return exec(id, args);
            exporting.resolve();
            await proceed.promise;
            if (failure === 'export') throw new Error('API unavailable');
            if (failure === 'invalid response') return { exit_code: 0, stdout: '' };
            fs.rmSync(path.join(root, name));
            fs.mkdirSync(path.join(root, name));
            return { exit_code: 0, stdout: JSON.stringify([Date.now(), Buffer.from('updated').toString('base64')]) };
        };
        const run = runtime.start(builder.build());
        await exporting.promise;
        const cleanup = Promise.all([run.stop(), run.release!()]);
        proceed.resolve();
        assert.match((await run.wait()).outputIncomplete!, /credential write-back failed.*Fly app agents, Machine machine, \/home\/node\/\.claude/);
        await cleanup;
        assert.equal(api.destroyed, 0);
    }
});

test('guest credential export distinguishes a missing file from a failed read', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-export-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'credential');
    const exportFile = () => execFileSync('python3', ['-I', '-c', wrapper, 'export', file],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(JSON.parse(exportFile()), null);
    fs.writeFileSync(file, 'refresh');
    assert.equal(JSON.parse(exportFile())[1], Buffer.from('refresh').toString('base64'));
    fs.truncateSync(file, 1048577);
    assert.throws(exportFile, /Invalid credential file/);
});

test('forced stop keeps a Machine with pending credential exports', async t => {
    const { runtime, builder, api } = fixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-credential-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    builder.credentialBind(root, '/home/node/.claude', false, { provider: 'claude', store: 'config', perRun: true });
    api.status = 'running';
    api.ignoreStop = true;
    const run = runtime.start(builder.build());
    await api.probing.promise;
    await run.stop('SIGTERM', 0);
    assert.match((await run.wait()).outputIncomplete!, /Recover credentials from Fly app agents, Machine machine/);
    await run.release!();
    assert.deepEqual(api.signals, ['SIGTERM', 'SIGALRM']);
    assert.equal(api.destroyed, 0);
});

test('a stream over the Machine read limit returns the bounded tail and reports truncation', async () => {
    const { runtime, builder, api } = fixture();
    const bytes = Buffer.alloc(17 * 1024 * 1024, 65);
    bytes.write('\nauthoritative tail\n', bytes.length - 20);
    api.files.set(RUN + '/stdout', bytes);
    const offsets: number[] = [];
    const exec = api.exec.bind(api);
    api.exec = async (id, args) => {
        if (args[3] === 'chunk' && args[4] === RUN + '/stdout') offsets.push(Number(args[5]));
        return exec(id, args);
    };
    const run = runtime.start(builder.build());
    const result = await run.wait();
    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /truncated/);
    assert.match(result.stdout, /authoritative tail/);
    assert.equal(Math.min(...offsets), 1024 * 1024);
    await run.release!();
});

test('the Claude Code and Codex task builders can launch their prepared clone specs', async t => {
    const { buildCodexRunSpec } = await import('../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.ts');
    const { buildClaudeRunSpec } = await import('../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts');
    const { prepareLaunch } = await import('../packages/core/src/agents/runtime/fly/launch.ts');
    const { flyConfig } = await import('../packages/core/src/agents/runtime/fly/config.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-spec-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const type of ['claude', 'codex'] as const) {
        const config = { type, id: 'agent', enabled: true, alias: type, dockerImage: 'propr/agent', configPath: root, supportedModels: [] };
        const options = { worktreePath: root, githubToken: 'repo-access', gitMountArgs: [], issueNumber: 1 };
        const spec = type === 'claude' ? buildClaudeRunSpec(config, 5, options) : buildCodexRunSpec(config, options);
        spec.workspace = fixture().builder.spec.workspace;
        spec.mounts = spec.mounts.filter(m => m.purpose !== 'workspace');
        const prepared = prepareLaunch(spec, { stdinData: 'prompt' }, flyConfig(env));
        const agent = prepared.launch.config.files.find(file => file.guest_path.endsWith('fly-agent.json'))!;
        const payload = JSON.parse(Buffer.from(agent.raw_value, 'base64').toString());
        assert.deepEqual(payload.argv, [spec.repoSetup!.providerEntrypoint, ...spec.args]);
        assert.equal(payload.env.GH_TOKEN, options.githubToken);
    }
});

test('extension admission refuses Fly before workspace preparation', async () => {
    const { launchContext } = await import('../packages/core/src/extensions/extensionLaunchContext.ts');
    const { runAgent } = await import('../packages/core/src/agents/runtime/registry.ts');
    await launchContext.run({ taskId: 'ext', mounts: [], secrets: [], beforeLaunch: async () => {} }, async () => {
        await assert.rejects(runAgent({ runtime: 'fly-machines' }, fixture().builder.build(), { taskId: 'ext', extensionAgentLaunch: true }),
            { name: 'AgentRuntimeCapabilityError', capability: 'extensions' });
    });
});

test('the stall watchdog signals a silent run and collects its final output', async () => {
    const { runtime, builder, api } = fixture();
    api.status = 'running';
    const run = runtime.start(builder.build(), { preserveOutputOnTimeout: true,
        watchdog: { stallTimeoutMs: 15, toolStallTimeoutMs: 0, degenerateOutputLimit: 0 } });
    const result = await run.wait();
    assert.equal(result.watchdogTrip?.rule, 'inactivity');
    assert.deepEqual(api.signals, ['SIGTERM']);
    assert.equal(result.exitCode, 143);
    assert.equal(api.destroyed, 1);
    await run.release!();
});

test('Machines API adopts a lost create response, uses argv exec and accepts a previously destroyed Machine', async t => {
    const { MachinesClient } = await import('../packages/core/src/agents/runtime/fly/api.ts');
    const { prepareLaunch } = await import('../packages/core/src/agents/runtime/fly/launch.ts');
    const { flyConfig } = await import('../packages/core/src/agents/runtime/fly/config.ts');
    const config = flyConfig(env);
    const { launch } = prepareLaunch(fixture().builder.build(), {}, config);
    let creates = 0;
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
        assert.equal((init.headers as Record<string, string>).Authorization, token);
        const body = init.body && JSON.parse(String(init.body));
        assert.ok(!String(init.body).includes(token));
        if (url.endsWith('/machines')) {
            creates++;
            throw new Error('lost response');
        }
        if (url.includes('?metadata.propr_run_id=')) return Response.json([{ name: launch.name, id: 'm-1' }]);
        if (url.endsWith('/exec')) {
            assert.deepEqual(body.command, ['printf', '%s', 'hello world']);
            return Response.json({ stdout: 'hello world', exit_code: 0 });
        }
        if (url.endsWith('/signal')) {
            assert.deepEqual(body, { signal: 'SIGTERM' });
            return Response.json({});
        }
        assert.equal(init.method, 'DELETE');
        assert.match(url, /force=true/);
        return new Response(null, { status: 404 });
    });
    const api = new MachinesClient(config);
    const id = await api.create(launch);
    assert.equal(creates, 1);
    assert.equal(id, 'm-1');
    assert.equal((await api.exec(id, ['printf', '%s', 'hello world'])).stdout, 'hello world');
    await api.signal(id, 'SIGTERM');
    await api.destroy(id);
});

test('a Machine lost during retrieval reports unavailable output even when the workspace read also fails', async () => {
    const { runtime, api, builder } = fixture();
    const exec = api.exec.bind(api);
    api.exec = (id, args) => {
        if (args[3] !== 'probe') throw new Error('Machine disappeared');
        return exec(id, args);
    };
    const run = runtime.start(builder.build());
    const result = await run.wait();
    assert.equal(result.exitCode, -1);
    assert.match(result.outputIncomplete!, /output unavailable: stdout, stderr/);
    assert.match(result.stderr, /workspace result retrieval failed/);
    await run.release!();
});

test('a failed bundle or status read preserves the remote bundle through stop and release', async () => {
    for (const file of ['result.bundle', 'status']) {
        const { runtime, api, builder } = fixture();
        const bundle = RUN + '/workspace/result.bundle';
        api.files.set(bundle, Buffer.alloc(256 * 1024 + 1, 42));
        const reading = Promise.withResolvers<void>();
        const fail = Promise.withResolvers<void>();
        const exec = api.exec.bind(api);
        api.exec = async (id, args) => {
            if (args[3] === 'chunk' && args[4] === RUN + '/workspace/' + file &&
                (file === 'status' || Number(args[5]) > 0)) {
                reading.resolve();
                await fail.promise;
                throw new Error('retrieval interrupted');
            }
            return exec(id, args);
        };
        const run = runtime.start(builder.build());
        await reading.promise;
        const cleanup = Promise.all([run.stop(), run.release!()]);
        fail.resolve();
        const result = await run.wait();
        assert.equal(result.exitCode, -1);
        assert.match(result.outputIncomplete!, /workspace result retrieval failed/);
        assert.equal(run.recoveryLocation, 'Fly app agents, Machine machine, ' + RUN + '/workspace');
        assert.ok(result.stderr.includes(run.recoveryLocation));
        await cleanup;
        assert.equal(api.destroyed, 0);
        assert.equal(api.files.get(bundle)!.length, 256 * 1024 + 1);
    }
});

test('forced cleanup preserves the Machine when its final status cannot be read', async () => {
    const { runtime, api, builder } = fixture();
    api.status = 'running';
    const exec = api.exec.bind(api);
    api.exec = async (id, args) => {
        if (args[3] === 'probe' && api.signals.length) throw new Error('probe failed');
        return exec(id, args);
    };
    const run = runtime.start(builder.build());
    await api.probing.promise;
    await run.stop('SIGTERM', 0);
    assert.deepEqual(api.signals, ['SIGTERM']);
    assert.match((await run.wait()).outputIncomplete!, /Machine machine/);
    await run.release!();
    assert.equal(api.destroyed, 0);
});

test('guests with a fallback bundle or pending credentials outlive the orphan expiry', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-recovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('python3', ['-I', '-c', wrapper + `
from unittest.mock import patch
run = Path(sys.argv[2])
(run / 'workspace').mkdir()
bundle = run / 'workspace/result.bundle'
bundle.touch()
with patch('time.time', return_value=run.stat().st_mtime + 1000), patch('time.sleep', side_effect=lambda _: bundle.unlink()) as sleep:
    wait_for_retrieval()
    sleep.assert_called_once()
with patch('time.time', return_value=run.stat().st_mtime + 1000), patch('time.sleep', side_effect=InterruptedError) as sleep:
    try:
        wait_for_retrieval(credential_pending=True)
    except InterruptedError:
        pass
    sleep.assert_called_once()
`, 'test', root]);
});

test('a running cost guard resumes after a failed chunk and stops on a split usage record', async () => {
    const { runtime, api, builder } = fixture();
    api.status = 'running';
    const stdout = RUN + '/stdout';
    const chunkSize = 256 * 1024;
    const usage = '{"total_cost_usd":2}';
    const first = 'x'.repeat(chunkSize - 3);
    api.files.set(stdout, Buffer.from(first + '\n' + usage + '\n'));
    const exec = api.exec.bind(api);
    const offsets: number[] = [];
    api.exec = (id, args) => {
        if (args[3] === 'chunk' && args[4] === stdout) {
            offsets.push(Number(args[5]));
            if (offsets.length === 2) throw new Error('temporary read failure');
        }
        return exec(id, args);
    };
    const observed: string[] = [];
    await runWithActiveRunCostCap({
        taskId: 'task', exceeded: false, admit: async () => {},
        beginExecution: stop => ({
            observeLine(line) {
                observed.push(line);
                if (line === usage) {
                    assert.equal(api.status, 'running');
                    api.files.set(stdout, Buffer.concat([api.files.get(stdout)!, Buffer.from('final')]));
                    stop('cost cap exceeded');
                }
            },
            finish: async () => null,
        }),
    }, async () => {
        const run = runtime.start(builder.build(), { preserveOutputOnTimeout: true, timeout: 5000 });
        const result = await run.wait();
        assert.equal(result.costCapExceeded, true);
        assert.equal(result.exitCode, 143);
        assert.deepEqual(api.signals, ['SIGTERM']);
        assert.deepEqual(observed, [first, usage, 'final']);
        assert.deepEqual(offsets, [0, chunkSize, chunkSize, first.length + usage.length + 2]);
        await run.release!();
    });
});

test('a capped run stops when authoritative usage stays unreadable', async () => {
    const { runtime, api, builder } = fixture();
    api.status = 'running';
    api.failedRead = RUN + '/stdout';
    await runWithActiveRunCostCap({
        taskId: 'task', exceeded: false, admit: async () => {},
        beginExecution: () => ({ observeLine: () => assert.fail('no complete record'), finish: async () => null }),
    }, async () => {
        const run = runtime.start(builder.build(), { timeout: 5000, preserveOutputOnTimeout: true });
        assert.match((await run.wait()).outputIncomplete!, /unavailable for live cost accounting/);
        assert.deepEqual(api.signals, ['SIGTERM']);
        await run.release!();
    });
});

test('a capped run stops if an individual usage record cannot fit in the capture limit', async () => {
    const { runtime, api, builder } = fixture();
    api.status = 'running';
    api.files.set(RUN + '/stdout', Buffer.alloc(16 * 1024 * 1024 + 1, 65));
    await runWithActiveRunCostCap({
        taskId: 'task', exceeded: false, admit: async () => {},
        beginExecution: () => ({ observeLine: () => assert.fail('incomplete record'), finish: async () => null }),
    }, async () => {
        const run = runtime.start(builder.build(), { timeout: 5000, preserveOutputOnTimeout: true });
        assert.match((await run.wait()).outputIncomplete!, /16 MiB cost accounting limit/);
        assert.deepEqual(api.signals, ['SIGTERM']);
        await run.release!();
    });
});
