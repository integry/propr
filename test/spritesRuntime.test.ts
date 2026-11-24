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

test('a lease lasts through result retrieval and release restores the entire filesystem once', async () => {
    const { runtime, client, builder } = fixture();
    const run = runtime.start(builder.build());
    assert.equal((await run.wait()).exitCode, 0);
    const sprite = client.created[0];
    assert.deepEqual(sprite.events, ['checkpoint', 'restore', 'launch']);
    for (const name of ['/home/node/workspace/change', '/opt/propr/result/result.bundle',
        '/tmp/propr-antigravity-home/.gemini/antigravity-cli/antigravity-oauth-token', '/tmp/claude-logs/run', '/tmp/scratch/run']) {
        sprite.files.set(name, Buffer.from('private'));
    }
    assert.equal((await run.readFile!('/tmp/propr-workspace-result/result.bundle'))?.toString(), 'private');
    const concurrent = runtime.start(builder.build());
    await concurrent.wait();
    assert.equal(client.created.length, 2);
    await Promise.all([run.release!(), run.release!()]);
    assert.deepEqual(sprite.files, sprite.baseline);
    assert.deepEqual(sprite.events.slice(-2), ['launch', 'restore']);
    const next = runtime.start(builder.build());
    await next.wait();
    assert.equal(sprite.launches.length, 2);
    await Promise.all([next.release!(), concurrent.release!()]);
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
    assert.deepEqual(client.created[1].events, ['checkpoint', 'restore']);
    const next = runtime.start(builder.build());
    await next.wait();
    await next.release!();
    assert.equal(client.created[1].launches.length, 1);
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
    assert.equal(input.agent.env.HOME, '/tmp/propr-antigravity-home');
    assert.deepEqual(input.files, [[relative, Buffer.from('baseline').toString('base64'), false]]);
    await run.release!();
    assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), 'refreshed');
    assert.deepEqual(sprite.events.slice(-3), ['export', 'read-export', 'restore']);
});

test('launcher reader accepts only bounded regular files without following any component', t => {
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

test('stop settles during creation and a late create response deletes only its own Sprite', { timeout: 3000 }, async () => {
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
    assert.deepEqual(client.deleted, [client.created[0].name]);
    assert.deepEqual(client.created[0].events, []);
    await next.release!();
});

test('the deadline aborts an active setup command before checkpoint or launch', { timeout: 3000 }, async () => {
    const { runtime, client, builder } = fixture();
    const started = Promise.withResolvers<AbortSignal>();
    const resume = Promise.withResolvers<void>();
    client.setup = sprite => {
        const exec = sprite.execFile.bind(sprite);
        sprite.execFile = async (cmd, args, options) => {
            started.resolve(options!.signal!);
            await resume.promise;
            return exec(cmd, args, options);
        };
    };
    const run = runtime.start(builder.build(), { timeout: 50 });
    const signal = await started.promise;
    // Keep the event loop alive while the runtime's unref'ed deadline fires.
    const timer = setTimeout(() => {}, 2000);
    try {
        await assert.rejects(run.wait(), { name: 'TimeoutError' });
        assert.equal(signal.aborted, true);
        resume.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(client.deleted, [client.created[0].name]);
        assert.deepEqual(client.created[0].events, []);
    } finally { clearTimeout(timer); }
});

for (const stage of ['list checkpoints', 'upload'] as const) {
    test(`cancellation during ${stage} disposes of the Sprite and prevents later startup steps`, { timeout: 3000 }, async () => {
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
        assert.deepEqual(client.deleted, [client.created[0].name]);
        resume.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(client.created[0].events, stage === 'upload' ? ['checkpoint', 'restore'] : ['checkpoint']);
    });
}
