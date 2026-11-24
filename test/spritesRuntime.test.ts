import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';
import { closeConnection } from '../packages/core/src/db/connection.ts';
after(closeConnection);
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { SpritesRuntime } from '../packages/core/src/agents/runtime/spritesRuntime.ts';
import { buildAgentRunRepoSetup } from '../packages/core/src/claude/docker/repoSetupWrapper.ts';
import { WORKSPACE_DIRECT_AGENT_LAUNCH, WORKSPACE_TRANSPORT_SCRIPT, WORKSPACE_TRANSPORT_TOKEN_ENV } from '../packages/core/src/git/workspaceTransportScript.ts';
import { CloneWorkspaceTransport } from '../packages/core/src/git/workspaceCloneTransport.ts';
import { FakeSprites } from './helpers/fakeSprites.ts';

const token = 'test-org-secret';
function fixture() {
    const client = new FakeSprites();
    const runtime = new SpritesRuntime(client, { PROPR_SPRITES_TOKEN: token });
    const builder = new AgentRunSpecBuilder({
        name: 'test', stdin: true, agentType: 'antigravity', image: 'test', network: agentRunNetwork('bridge'), user: '0:0',
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote: 'unused', baseRef: 'base', baseCommit: 'unused', branch: 'test', resultDir: '/tmp/propr-workspace-result', script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('agy', '--version');
    return { runtime, client, builder };
}

test('a lease lasts through result retrieval and release wipes the separate tmp disk before restoring the checkpoint once', async () => {
    const { runtime, client, builder } = fixture();
    const run = runtime.start(builder.build());
    assert.equal((await run.wait()).exitCode, 0);
    const sprite = client.created[0];
    assert.deepEqual(sprite.events, ['checkpoint', 'restore', 'launch']);
    for (const name of ['/home/node/workspace/change', '/opt/propr/result/result.bundle',
        '/opt/propr/run/tmp/propr-antigravity-home/.gemini/antigravity-cli/antigravity-oauth-token', '/tmp/claude-logs/run', '/tmp/scratch/run']) {
        sprite.files.set(name, Buffer.from('private'));
    }
    assert.equal((await run.readFile!('/tmp/propr-workspace-result/result.bundle'))?.toString(), 'private');
    const concurrent = runtime.start(builder.build());
    await concurrent.wait();
    assert.equal(client.created.length, 2);
    await Promise.all([run.release!(), run.release!()]);
    assert.deepEqual(sprite.files, sprite.baseline);
    assert.deepEqual(sprite.events.slice(-4), ['launch', 'restart', 'wipe', 'restore']);
    const next = runtime.start(builder.build());
    await next.wait();
    assert.equal(sprite.launches.length, 2);
    await Promise.all([next.release!(), concurrent.release!()]);
});

test('closing the runtime deletes idle Sprites once and leaves leased Sprites until release', async () => {
    const { runtime, client, builder } = fixture();
    const idle = runtime.start(builder.build());
    await idle.wait();
    const leased = runtime.start(builder.build());
    await leased.wait();
    await idle.release!();
    await Promise.all([runtime.close(), runtime.close()]);
    assert.deepEqual(client.deleted, [client.created[0].name]);
    assert.throws(() => runtime.start(builder.build()), /closed/);
    await leased.release!();
    assert.deepEqual(client.deleted, client.created.map(sprite => sprite.name));
    assert.equal(client.created.length, 2);
});

test('closing during a failed restore discards the Sprite without provisioning a replacement', async () => {
    const { runtime, client, builder } = fixture();
    const run = runtime.start(builder.build());
    await run.wait();
    const restoring = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    client.created[0].restoreCheckpoint = async () => {
        restoring.resolve();
        await resume.promise;
        throw new Error('restore failed');
    };
    const released = run.release!();
    await restoring.promise;
    await runtime.close();
    resume.resolve();
    await released;
    assert.equal(client.created.length, 1);
    assert.deepEqual(client.deleted, [client.created[0].name]);
});

test('a failed or killed run restores before reuse and a failed restore destroys and reprovisions', async () => {
    const { runtime, client, builder } = fixture();
    client.setup = sprite => { sprite.exitCode = 19; };
    const failed = runtime.start(builder.build());
    assert.equal((await failed.wait()).exitCode, 19);
    await failed.release!();
    const sprite = client.created[0];
    sprite.hold = true;
    sprite.launched = Promise.withResolvers<void>();
    const killed = runtime.start(builder.build());
    await sprite.launched.promise;
    await killed.stop();
    await assert.rejects(killed.wait());
    await killed.release!();
    assert.equal(sprite.events.filter(event => event === 'restore').length, 3);
    sprite.hold = false;
    const last = runtime.start(builder.build());
    await last.wait();
    sprite.failRestore = true;
    await last.release!();
    assert.deepEqual(client.deleted, [sprite.name]);
    const next = runtime.start(builder.build());
    await next.wait();
    await next.release!();
    assert.equal(client.created[1].launches.length, 1);
});

test('a failed tmp wipe discards the Sprite before another lease', async () => {
    const { runtime, client, builder } = fixture();
    const run = runtime.start(builder.build());
    await run.wait();
    const sprite = client.created[0];
    sprite.failWipe = true;
    await run.release!();
    assert.deepEqual(sprite.events.slice(-2), ['restart', 'wipe']);
    assert.deepEqual(client.deleted, [sprite.name]);
    const next = runtime.start(builder.build());
    await next.wait();
    assert.equal(client.created[1].launches.length, 1);
    await next.release!();
});

test('Sprite setup accepts an explicit sudo denial and refuses grants or unknown output', () => {
    const check = (listing: string, status: number) => spawnSync('bash', ['-c',
        'source scripts/sprites-agent-setup.sh; sudo() { echo "$listing"; return "$status"; }; verify_node_sudo',
    ], { env: { ...process.env, listing, status: String(status) }, encoding: 'utf8' });
    for (const status of [0, 1]) assert.equal(check('User node is not allowed to run sudo on sprite.', status).status, 0);
    assert.match(check('User node may run the following commands on sprite:', 0).stderr, /node has sudo privileges/);
    assert.match(check('unable to read sudoers', 1).stderr, /could not verify sudo privileges/);
});

test('setup failure reports the stderr tail and retains the SDK error', async () => {
    const { runtime, client, builder } = fixture();
    const cause = Object.assign(new Error('Command failed with exit code 1'), {
        stderr: Buffer.from('old setup output' + ' '.repeat(5000) + 'ProPR Sprite setup: missing node'),
    });
    client.setup = sprite => { sprite.execFile = async () => { throw cause; }; };
    await assert.rejects(runtime.start(builder.build()).wait(), {
        message: 'Failed to provision the clean Sprite checkpoint: ProPR Sprite setup: missing node', cause,
    });
    assert.deepEqual(client.deleted, [client.created[0].name]);
});

test('credentials use one upload and only checked exports reach the broker. The org token stays off the Sprite and out of output', async t => {
    const { runtime, client, builder } = fixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const relative = 'antigravity-cli/antigravity-oauth-token';
    fs.mkdirSync(path.join(root, 'antigravity-cli'));
    fs.writeFileSync(path.join(root, relative), 'baseline');
    builder.credentialBind(root, '/home/node/.gemini-source', true, { provider: 'antigravity', store: 'config', perRun: true })
        .env('SPRITES_TOKEN', token).env('OTHER', token).env('PROPR_ANTIGRAVITY_SOURCE_CONFIG', '/home/node/.gemini-source');
    builder.spec.repoSetup = buildAgentRunRepoSetup('antigravity');
    client.setup = sprite => { sprite.credential = 'refreshed'; sprite.output = token + '\n'; };
    const run = runtime.start(builder.build());
    const result = await run.wait();
    const sprite = client.created[0];
    assert.equal(result.stdout, '[REDACTED]\n');
    assert.ok(!sprite.launches[0].includes(token));
    const input = JSON.parse(sprite.launches[0]);
    // The clone wrapper drops privileges before even the repository setup hook.
    // Neither that hook nor the agy entrypoint runs in its root process.
    assert.equal(input.transport[3], WORKSPACE_DIRECT_AGENT_LAUNCH);
    assert.deepEqual(input.transport.slice(4), ['/usr/bin/python3', '-I', '/opt/propr/launcher.py', 'agent']);
    assert.ok(input.agent.argv.includes('/opt/propr/entrypoints/antigravity-entrypoint.sh'));
    assert.ok(!sprite.launches[0].includes('.gemini-source'));
    assert.equal(input.agent.env.PROPR_ANTIGRAVITY_SOURCE_CONFIG, undefined);
    assert.equal(input.agent.env.HOME, '/opt/propr/run/tmp/propr-antigravity-home');
    assert.deepEqual(input.files, [[relative, Buffer.from('baseline').toString('base64'), false]]);
    await run.release!();
    assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), 'refreshed');
    assert.deepEqual(sprite.events.slice(-5), ['export', 'read-export', 'restart', 'wipe', 'restore']);
});

test('launcher reader accepts only bounded regular files without following any component', { skip: process.platform !== 'linux' }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-export-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const valid = path.join(dir, 'valid');
    fs.writeFileSync(valid, 'ok');
    fs.symlinkSync(valid, path.join(dir, 'link'));
    fs.symlinkSync(dir, path.join(dir, 'parent'));
    fs.writeFileSync(path.join(dir, 'large'), Buffer.alloc(1024 * 1024 + 1));
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    const read = (file: string) => spawnSync('python3', ['-I', '-c',
        'import runpy,sys,pathlib; print(runpy.run_path("scripts/sprites-launcher.py")["regular"](pathlib.Path(sys.argv[1]))[0])', file], { timeout: 2000 });
    assert.equal(read(valid).status, 0);
    for (const file of ['link', 'parent/valid', 'large', 'pipe', '.']) assert.equal(read(path.join(dir, file)).status, 1, file);
});

test('a non-root credential reader can traverse a 0711 run directory', { skip: process.platform !== 'linux' }, t => {
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-run-'));
    const home = path.join(run, 'home');
    t.after(() => {
        fs.chmodSync(home, 0o700);
        fs.rmSync(run, { recursive: true, force: true });
    });
    fs.mkdirSync(home);
    const file = path.join(home, 'credential');
    fs.writeFileSync(file, 'refresh');
    fs.chmodSync(file, 0o444);
    fs.chmodSync(run, 0o711);
    // An unprivileged test runner owns its fixture. Make the next component
    // search-only for the owner too, so a read-only directory fd always fails.
    fs.chmodSync(home, 0o111);
    const result = spawnSync('python3', ['-I', '-c', `
import os, pathlib, runpy, sys
regular = runpy.run_path('scripts/sprites-launcher.py')['regular']
if os.geteuid() == 0:
    os.setgroups([])
    os.setgid(65534)
    os.setuid(65534)
assert os.geteuid() != 0
assert regular(pathlib.Path(sys.argv[1]))[0] == b'refresh'
`, file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});

test('an invalid credential export still restores the checkpoint and releases the lease', async t => {
    const { runtime, client, builder } = fixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-export-failure-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    builder.credentialBind(root, '/home/node/.gemini-source', true, { provider: 'antigravity', store: 'config', perRun: true });
    const run = runtime.start(builder.build());
    await run.wait();
    const sprite = client.created[0];
    sprite.failExport = true;
    await assert.rejects(run.release!(), /invalid export/);
    assert.deepEqual(sprite.files, sprite.baseline);
    assert.equal(sprite.events.at(-1), 'restore');
    sprite.failExport = false;
    const next = runtime.start(builder.build());
    await next.wait();
    await next.release!();
    assert.equal(client.created.length, 1);
});

for (const failure of ['read', 'verification'] as const) {
    test(`clone cleanup keeps the named Sprite when bundle ${failure} fails`, async t => {
        const { runtime, client, builder } = fixture();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-recovery-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const remote = path.join(root, 'remote.git');
        const worktree = path.join(root, 'worker');
        const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
        git('init', '-q', '--bare', remote);
        git('init', '-q', worktree);
        git('-C', worktree, '-c', 'user.name=test', '-c', 'user.email=test@example.org', 'commit', '-q', '--allow-empty', '-m', 'base');
        git('-C', worktree, 'remote', 'add', 'origin', 'https://github.com/example/recovery.git');
        const revoked: string[] = [];
        const transport = new CloneWorkspaceTransport({
            remoteUrl: () => remote, createRunId: () => 'test', workerToken: async () => undefined,
            mintToken: async () => 'repo-token', revokeToken: async value => { revoked.push(value); },
        });
        const spec = builder.build();
        spec.workspace = { ...spec.workspace, hostPath: worktree };
        const prepared = await transport.prepare(spec);
        const run = runtime.start(prepared.spec, { extraEnvVars: prepared.launchEnvironment });
        const result = await run.wait();
        const sprite = client.created[0];
        sprite.files.set('/opt/propr/result/status', Buffer.from('bundle abc'));
        sprite.files.set('/opt/propr/result/result.bundle', Buffer.from('only copy'));
        const handle = failure === 'verification' ? run : { ...run, readFile: async (file: string) => {
            if (file.endsWith('.bundle')) throw new Error('connection lost');
            return run.readFile!(file);
        } };
        await assert.rejects(prepared.complete(handle, result), new RegExp('kept for recovery at Sprite ' + sprite.name));
        await prepared.cleanup(handle);
        const next = runtime.start(builder.build());
        await next.wait();
        assert.equal(client.created.length, 2);
        assert.deepEqual(sprite.events, ['checkpoint', 'restore', 'launch']);
        assert.deepEqual(client.deleted, []);
        assert.deepEqual(revoked, ['repo-token']);
        assert.equal((await run.readFile!('/tmp/propr-workspace-result/result.bundle'))?.toString(), 'only copy');
        await next.release!();
    });
}

test('launch delivers explicit extras with file and spec precedence and keeps transport credentials separate', async t => {
    const { runtime, client, builder } = fixture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-env-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'agent.env');
    fs.writeFileSync(file, 'FROM_FILE=file\nOVERRIDE=file\n');
    builder.envFile(file).env('OVERRIDE', 'spec');
    const extraEnvVars = { TOOL_POLICY: 'enabled', FROM_FILE: 'extra', OVERRIDE: 'extra',
        SECRET_ALIAS: token, SPRITES_TOKEN: 'filtered', [WORKSPACE_TRANSPORT_TOKEN_ENV]: 'repo-token' };
    const run = runtime.start(builder.build(), { extraEnvVars });
    extraEnvVars.TOOL_POLICY = 'changed';
    await run.wait();
    const { agent, transportEnv } = JSON.parse(client.created[0].launches[0]);
    assert.equal(agent.env.TOOL_POLICY, 'enabled');
    assert.equal(agent.env.FROM_FILE, 'file');
    assert.equal(agent.env.OVERRIDE, 'spec');
    assert.equal(agent.env.SECRET_ALIAS, undefined);
    assert.equal(agent.env.SPRITES_TOKEN, undefined);
    assert.equal(agent.env[WORKSPACE_TRANSPORT_TOKEN_ENV], undefined);
    assert.equal(transportEnv[WORKSPACE_TRANSPORT_TOKEN_ENV], 'repo-token');
    await run.release!();
});

test('stop settles during creation and a late create warms the pool', { timeout: 3000 }, async () => {
    const { runtime, client, builder } = fixture();
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const create = client.createSprite.bind(client);
    client.createSprite = async name => {
        const sprite = await create(name);
        started.resolve();
        await resume.promise;
        return sprite;
    };
    const run = runtime.start(builder.build());
    await started.promise;
    await run.stop();
    await assert.rejects(run.wait());
    client.createSprite = create;
    const next = runtime.start(builder.build());
    await next.wait();
    resume.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(client.deleted, []);
    assert.deepEqual(client.created[0].events, ['checkpoint', 'restore']);
    const warm = runtime.start(builder.build());
    await warm.wait();
    assert.equal(client.created.length, 2);
    await Promise.all([next.release!(), warm.release!()]);
    await runtime.close();
});

test('a short agent deadline starts after slow setup and still stops a running agent', { timeout: 3000 }, async () => {
    const { runtime, client, builder } = fixture();
    client.setup = sprite => {
        sprite.hold = true;
        const exec = sprite.execFile.bind(sprite);
        sprite.execFile = async (cmd, args, options) => {
            if (args.some(arg => arg.endsWith('sprites-agent-setup.sh'))) {
                await new Promise(resolve => setTimeout(resolve, 90));
                assert.equal(options!.signal!.aborted, false);
            }
            return exec(cmd, args, options);
        };
    };
    const timer = setTimeout(() => {}, 2000);
    try {
        const run = runtime.start(builder.build(), { timeout: 30, preserveOutputOnTimeout: true });
        const result = await run.wait();
        assert.equal(result.timedOut, true);
        assert.equal(result.stdout, 'agent output');
        await run.release!();
        assert.deepEqual(client.deleted, []);
    } finally { clearTimeout(timer); await runtime.close(); }
});

for (const stage of ['list checkpoints', 'upload'] as const) {
    test(`cancellation during ${stage} prevents launch and keeps only clean Sprites`, { timeout: 3000 }, async () => {
        const { runtime, client, builder } = fixture();
        const started = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const hold = async () => { started.resolve(); await resume.promise; };
        client.setup = sprite => {
            if (stage === 'list checkpoints') {
                const list = sprite.listCheckpoints.bind(sprite);
                sprite.listCheckpoints = async () => { await hold(); return list(); };
            } else {
                const fs = sprite.filesystem();
                sprite.filesystem = () => ({ ...fs, writeFile: async (file, data) => {
                    if (file.startsWith('/opt/propr/inbox/')) await hold();
                    await fs.writeFile(file, data);
                } });
            }
        };
        const controller = new AbortController();
        const run = runtime.start(builder.build(), { signal: controller.signal });
        await started.promise;
        controller.abort();
        await assert.rejects(run.wait(), { name: 'AbortError' });
        await run.release!();
        assert.deepEqual(client.deleted, stage === 'upload' ? [client.created[0].name] : []);
        resume.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(client.created[0].events, ['checkpoint', 'restore']);
        await runtime.close();
    });
}

test('invalid upload payloads fail before a Sprite is acquired', async () => {
    const { runtime, builder, client } = fixture();
    const spec = builder.build();
    await assert.rejects(runtime.start({ ...spec, workspace: { ...spec.workspace, readOnly: true } }).wait(), /clone workspace/);
    await assert.rejects(runtime.start(spec, { stdinData: token }).wait(), /organization credential/);
    assert.deepEqual(client.created, []);
    await runtime.close();
});

test('stderr workflow markers fail the run even when the provider reports success', async () => {
    const { executeWithRepositoryWorkflow, repositoryWorkflowExecution } = await import('../packages/core/src/workflow/workflowExecution.ts');
    const { runtime, builder, client } = fixture();
    const result = await executeWithRepositoryWorkflow({ revision: 'base', fileRevision: 'blob', baseBranch: 'main',
        config: { hooks: { before_run: 'exit 7' }, validation: ['true'] }, timeoutMs: 1000, maxParallelTasks: 1 }, async () => {
        const marker = repositoryWorkflowExecution.getStore()!.marker;
        client.setup = sprite => { sprite.stderr = `\n${marker}:validation:0:0\n${marker}:hook:before_run:7\n`; };
        builder.spec.repoSetup = buildAgentRunRepoSetup('antigravity');
        const run = runtime.start(builder.build());
        await run.wait();
        await run.release!();
        return { success: true, modifiedFiles: [], logs: '', modelUsed: 'test', executionTimeMs: 0 };
    });
    assert.equal(result.success, false);
    assert.match(result.error!, /before_run failed with exit code 7/);
    assert.match(result.repositoryValidation!, /passed/i);
    await runtime.close();
});

test('a disconnected launch attaches once to the same non-TTY session', async () => {
    const { runtime, builder, client } = fixture();
    client.setup = sprite => { sprite.exitCode = -1; };
    const run = runtime.start(builder.build());
    assert.equal((await run.wait()).exitCode, 0);
    assert.deepEqual(client.created[0].events.filter(e => e === 'launch' || e === 'attach'), ['launch', 'attach']);
    await run.release!();
    await runtime.close();
});

test('failed pool initialization can be retried and cannot interrupt shutdown', async () => {
    const { client, builder } = fixture();
    let loads = 0;
    const env = { PROPR_SPRITES_TOKEN: token };
    const runtime = new SpritesRuntime(async key => {
        if (++loads === 1 || key !== token) throw new Error('SDK unavailable');
        return client;
    }, env);
    await assert.rejects(runtime.start(builder.build()).wait(), /SDK unavailable/);
    const warm = runtime.start(builder.build());
    await warm.wait();
    await warm.release!();
    env.PROPR_SPRITES_TOKEN = 'second-organization';
    const failed = runtime.start(builder.build());
    await Promise.all([assert.rejects(failed.wait(), /SDK unavailable|closed/), runtime.close()]);
    assert.deepEqual(client.deleted, [client.created[0].name]);
});

test('refusal at physical launch skips provider credential export', async t => {
    const { runWithActiveRunCostCap } = await import('../packages/core/src/budget/runCostGuardContext.ts');
    const { RunCostCapExceededError } = await import('../packages/core/src/budget/runCostCap.ts');
    const { runtime, client, builder } = fixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    builder.credentialBind(root, '/home/node/.gemini-source', true, { provider: 'antigravity', store: 'config', perRun: true });
    await runWithActiveRunCostCap({ taskId: 'test', exceeded: false, admit: async () => {},
        beginExecution: () => { throw new RunCostCapExceededError('cap reached'); } }, async () => {
        const run = runtime.start(builder.build(), { preserveOutputOnTimeout: true });
        assert.equal((await run.wait()).costCapExceeded, true);
        await run.release!();
    });
    assert.deepEqual(client.created[0].events, ['checkpoint', 'restore', 'restart', 'wipe', 'restore']);
    await runtime.close();
});

test('a stalled restore times out and release does not wait for replacement setup', { timeout: 3000 }, async t => {
    const { runtime, client, builder } = fixture();
    const run = runtime.start(builder.build());
    await run.wait();
    const restoreTimeout = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', (ms: number) => ms === 120_000 ? restoreTimeout.signal : timeout(ms));
    const restoring = Promise.withResolvers<void>();
    client.created[0].restoreCheckpoint = async () => {
        restoring.resolve();
        return new Promise(() => {});
    };
    const setup = Promise.withResolvers<void>();
    client.setup = sprite => {
        sprite.execFile = async () => {
            setup.resolve();
            return new Promise(() => {});
        };
    };
    const released = run.release!();
    await restoring.promise;
    restoreTimeout.abort();
    await released;
    await setup.promise;
    await runtime.close();
    assert.deepEqual(client.deleted, client.created.map(sprite => sprite.name));
});

test('ambient extension secrets are redacted from Sprite results and both handle streams', async () => {
    const { launchContext } = await import('../packages/core/src/extensions/extensionLaunchContext.ts');
    const { runtime, client, builder } = fixture();
    const secret = 'private-extension-test';
    client.setup = sprite => { sprite.output = secret; sprite.stderr = secret; };
    await launchContext.run({ taskId: 'test', secrets: [secret], mounts: [], beforeLaunch: async () => {} }, async () => {
        assert.throws(() => runtime.start(builder.build(), { taskId: 'test', extensionAgentLaunch: true }), /does not support extensions/);
        const helper = runtime.start(builder.build());
        const observed: string[] = [];
        helper.stdout.on('data', chunk => observed.push(String(chunk)));
        helper.stderr.on('data', chunk => observed.push(String(chunk)));
        const result = await helper.wait();
        assert.equal(result.stdout, '[REDACTED]');
        assert.equal(result.stderr, '[REDACTED]');
        assert.equal(observed.join(''), '[REDACTED][REDACTED]');
        await helper.release!();
    });
    await runtime.close();
});

test('CLI admission reuses Dockerfile pins for the same setup root', async t => {
    const { readSpritesCliPins } = await import('../packages/core/src/agents/runtime/sprites/spritesProvisioning.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-pins-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'Dockerfile.agent');
    fs.copyFileSync('Dockerfile.agent', file);
    const pins = readSpritesCliPins(root);
    fs.unlinkSync(file);
    assert.equal(readSpritesCliPins(root), pins);
});
