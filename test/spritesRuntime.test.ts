import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { FakeSpritesClient, type FakeAgent } from './helpers/fakeSprites.ts';

// The real Docker executor keeps the process alive after the tests; no test here runs Docker.
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        executeDockerCommand: async () => { throw new Error('Docker must not be called by the Sprites runtime'); },
    },
});

const { SpritesRuntime, SPRITES_RUNTIME_CAPABILITIES, SpritesRunInterruptedError, spritesRunId } = await import('../packages/core/src/agents/runtime/spritesRuntime.ts');
const { resolveSpritesRuntimeConfig, SpritesConfigurationError } = await import('../packages/core/src/agents/runtime/sprites/spritesConfig.ts');
const { readSpritesCliPins, readSpritesSetupBundle } = await import('../packages/core/src/agents/runtime/sprites/spritesProvisioning.ts');
const { spritesMountRefusal, resolveSpritesEnvironment, renderSpritesArgv } = await import('../packages/core/src/agents/runtime/sprites/spritesCommand.ts');
const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
const { assertAgentRuntimeSupports, resolveAgentRuntimeKind, getAgentRuntime } = await import('../packages/core/src/agents/runtime/registry.ts');
const { dockerAgentRuntimeInUse } = await import('../packages/core/src/agents/runtime/runtimeSelection.ts');
const { runningContainerMountSources } = await import('../packages/core/src/git/worktreeMounts.ts');
const { WORKSPACE_TRANSPORT_RESULT_DIR } = await import('../packages/core/src/git/workspaceTransportScript.ts');

const CLONE_SCRIPT = 'echo clone-wrapper';

function tempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cloneSpec(credentials: string, overrides: { name?: string; stdin?: boolean } = {}) {
    const spec = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent:test', name: overrides.name ?? 'claude-issue-7-abc', stdin: overrides.stdin ?? true, user: '0:0',
        network: agentRunNetwork('bridge'), security: { capAdd: ['CHOWN'] },
        workspace: { hostPath: '/tmp/worktree', containerPath: '/home/node/workspace', readOnly: false },
    })
        .bind('/tmp/claude-logs', '/tmp/claude-logs', false, 'logs')
        .credentialBind(credentials, '/home/node/.claude', false, { provider: 'claude', store: 'config', perRun: true })
        .tmpfs('/home/node/.claude/backups', 'rw,size=16m')
        .env('GH_TOKEN', 'gh-token')
        .env('PROPR_WORKSPACE_GIT_TOKEN')
        .env('UNSET_IN_LAUNCH')
        .command('claude', '-p', '-', '--output-format', 'stream-json')
        .build();
    spec.repoSetup = { agentType: 'claude', shell: '/bin/bash', script: 'setup-wrapper', providerEntrypoint: '/home/node/claude-entrypoint.sh', env: [{ name: 'PROPR_REPO_SETUP', value: '1' }] };
    spec.workspace = {
        ...spec.workspace, mode: 'clone',
        clone: { remote: 'https://github.com/o/r.git', baseRef: 'refs/propr/runs/x/base', baseCommit: 'abc', branch: 'b', resultRef: 'refs/propr/runs/x/result', resultDir: WORKSPACE_TRANSPORT_RESULT_DIR, script: CLONE_SCRIPT },
    };
    return spec;
}

function runtimeFor(client: FakeSpritesClient, environment: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = {
        PROPR_SPRITES_TOKEN: 'org-token', PROPR_SPRITES_WORKER_ID: 'w1', PROPR_SPRITES_REGION: 'ord',
        PROPR_SPRITES_KEEP_AWAKE_INTERVAL_MS: '20', PROPR_AGENT_CREDENTIAL_RUN_DIR: tempDir('propr-sprites-locks-'), ...environment,
    };
    return new SpritesRuntime({ createClient: async () => client as never, environment: env, reconnectDelayMs: 5 });
}

function claudeStore(): string {
    const dir = tempDir('propr-sprites-claude-');
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{"token":"old"}', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
    fs.writeFileSync(path.join(dir, 'history.jsonl'), 'not part of the manifest');
    return dir;
}

test('sprites is a registered runtime with clone-only, reattachable capabilities', () => {
    assert.equal(resolveAgentRuntimeKind(undefined, { PROPR_AGENT_RUNTIME: 'sprites' }), 'sprites');
    assert.equal(getAgentRuntime({ runtime: 'sprites' }).kind, 'sprites');
    assert.deepEqual(SPRITES_RUNTIME_CAPABILITIES.workspaceTransports, ['clone']);
    assert.equal(SPRITES_RUNTIME_CAPABILITIES.supportsBindMounts, false);
    assert.equal(SPRITES_RUNTIME_CAPABILITIES.supportsRestrictedNetwork, false);
    assert.equal(SPRITES_RUNTIME_CAPABILITIES.reattach, true);
});

test('constructing the runtime turns SDK client signals off unless the operator chose', () => {
    const environment: NodeJS.ProcessEnv = {};
    new SpritesRuntime({ environment });
    assert.equal(environment.SPRITES_CLIENT_SIGNALS, '0');
    const chosen: NodeJS.ProcessEnv = { SPRITES_CLIENT_SIGNALS: '1' };
    new SpritesRuntime({ environment: chosen });
    assert.equal(chosen.SPRITES_CLIENT_SIGNALS, '1');
});

test('config: org token required, prefix/region validated, defaults applied', () => {
    assert.throws(() => resolveSpritesRuntimeConfig({}), (error: Error) => error instanceof SpritesConfigurationError && /PROPR_SPRITES_TOKEN/.test(error.message));
    const config = resolveSpritesRuntimeConfig({ SPRITES_TOKEN: 't', PROPR_SPRITES_WORKER_ID: 'abc' });
    assert.equal(config.token, 't');
    assert.equal(config.namePrefix, 'propr');
    assert.equal(config.restoreCheckpoint, true);
    assert.throws(() => resolveSpritesRuntimeConfig({ SPRITES_TOKEN: 't', PROPR_SPRITES_NAME_PREFIX: '9bad' }), /PROPR_SPRITES_NAME_PREFIX/);
    assert.throws(() => resolveSpritesRuntimeConfig({ SPRITES_TOKEN: 't', PROPR_SPRITES_RESTORE_CHECKPOINT: 'maybe' }), /true or false/);
});

test('CLI pins come from Dockerfile.agent so a Sprite runs the image versions', () => {
    const dockerfile = fs.readFileSync('Dockerfile.agent', 'utf8');
    const pins = readSpritesCliPins(process.cwd());
    assert.ok(dockerfile.includes(`ARG CLAUDE_CLI_VERSION=${pins.CLAUDE_CLI_VERSION}`));
    assert.ok(dockerfile.includes(`ARG CODEX_CLI_VERSION=${pins.CODEX_CLI_VERSION}`));
    assert.ok(dockerfile.includes(`ARG ANTIGRAVITY_CLI_SHA512=${pins.ANTIGRAVITY_CLI_SHA512}`));
    const bundle = readSpritesSetupBundle(process.cwd());
    assert.deepEqual(bundle.files.map(file => file.name).sort(), ['agent-entrypoint.sh', 'antigravity-entrypoint.sh', 'claude-entrypoint.sh', 'codex-entrypoint.sh', 'gh-wrapper.sh', 'sprites-agent-setup.sh']);
    assert.match(bundle.hash, /^[0-9a-f]{16}$/);
});

test('mounts: credential stores, logs and small read-only files are provided; host directories and worktrees are refused', () => {
    const credentials = claudeStore();
    const spec = cloneSpec(credentials);
    assert.doesNotThrow(() => assertAgentRuntimeSupports(getAgentRuntime({ runtime: 'sprites' }), spec));
    const bind = (overrides: Record<string, unknown>) => ({ type: 'bind' as const, source: credentials, target: '/home/node/data', readOnly: false, purpose: 'data' as const, order: 0, ...overrides });
    assert.match(spritesMountRefusal(bind({}))!, /cannot share the host directory/);
    assert.match(spritesMountRefusal(bind({ purpose: 'workspace' }))!, /clone workspace transport/);
    assert.match(spritesMountRefusal(bind({ target: '/etc/passwd', readOnly: true }))!, /Sprite targets must be under/);
    assert.equal(spritesMountRefusal(bind({ source: path.join(credentials, 'settings.json'), readOnly: true })), undefined);
    const withHostDir = { ...spec, mounts: [...spec.mounts, bind({ order: 99 })] };
    assert.throws(() => assertAgentRuntimeSupports(getAgentRuntime({ runtime: 'sprites' }), withHostDir), /cannot share the host directory/);
});

test('command mapping reuses the entrypoint contract and Docker environment precedence', () => {
    const spec = cloneSpec(claudeStore());
    assert.deepEqual(renderSpritesArgv(spec), ['/bin/bash', '-lc', CLONE_SCRIPT, 'setup-wrapper', '/home/node/claude-entrypoint.sh', 'claude', '-p', '-', '--output-format', 'stream-json']);
    const environment = resolveSpritesEnvironment(spec, { PROPR_WORKSPACE_GIT_TOKEN: 'repo-token' });
    assert.equal(environment.get('PROPR_WORKSPACE_GIT_TOKEN'), 'repo-token');
    assert.equal(environment.get('PROPR_REPO_SETUP'), '1');
    assert.equal(environment.get('HOME'), '/root');
    assert.equal(environment.has('UNSET_IN_LAUNCH'), false);
    assert.match(environment.get('PATH')!, /^\/opt\/propr\/bin:/);
    assert.throws(() => renderSpritesArgv({ ...spec, profile: { ...spec.profile, agentType: 'vibe' } }), /does not run vibe agents yet/);
    assert.throws(() => renderSpritesArgv({ ...spec, workspace: { ...spec.workspace, mode: 'bind', clone: undefined } }), /only the clone workspace transport/);
});

test('a run creates, provisions and checkpoints its Sprite, syncs credentials both ways and reports startup timings', async () => {
    const client = new FakeSpritesClient();
    const credentials = claudeStore();
    let seen: Parameters<FakeAgent>[0] | undefined;
    client.configureSprite = sprite => {
        sprite.agent = async context => {
            seen = context;
            assert.equal(context.files.get('/home/node/.claude/.credentials.json')?.toString(), '{"token":"old"}');
            assert.equal(context.files.has('/home/node/.claude/history.jsonl'), false, 'only manifest files are copied');
            context.write('stderr', 'ProPR workspace transport: cloned abc into /home/node/workspace\n');
            context.write('stdout', '{"type":"system","session_id":"sess-1"}\n{"type":"assistant","message":{"id":"m1"}}\n');
            context.files.set('/home/node/.claude/.credentials.json', Buffer.from('{"token":"refreshed"}'));
            context.files.set(`${WORKSPACE_TRANSPORT_RESULT_DIR}/status`, Buffer.from('pushed deadbeef\n'));
            return 0;
        };
    };
    const runtime = runtimeFor(client);
    const sessions: string[] = [];
    const handle = runtime.start(cloneSpec(credentials), {
        timeout: 10_000, stdinData: 'the prompt', extraEnvVars: { PROPR_WORKSPACE_GIT_TOKEN: 'repo-token' }, onSessionId: id => { sessions.push(id); },
    });
    const streamed: string[] = [];
    handle.stdout.on('data', chunk => streamed.push(chunk.toString()));
    const result = await handle.wait();
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"session_id":"sess-1"/);
    assert.ok(result.messageTimestamps.has('m1'));
    assert.deepEqual(sessions, ['sess-1']);
    assert.equal(streamed.join(''), result.stdout);
    assert.equal(seen!.stdin, 'the prompt');
    assert.equal(seen!.env.get('PROPR_WORKSPACE_GIT_TOKEN'), 'repo-token');
    assert.deepEqual(seen!.argv.slice(0, 3), ['/bin/bash', '-lc', CLONE_SCRIPT]);

    const sprite = client.sprites.get('propr-w1-0')!;
    assert.deepEqual(client.created, ['propr-w1-0']);
    assert.equal(sprite.checkpoints.length, 1);
    assert.match(sprite.checkpoints[0].comment!, /^propr-setup [0-9a-f]{16}$/);
    const setup = sprite.calls.find(call => call.file === 'sudo' && call.args.includes('env'))!;
    assert.ok(setup.args.some(arg => /^CLAUDE_CLI_VERSION=\d/.test(arg)));
    assert.ok(setup.args.some(arg => /^CODEX_CLI_VERSION=\d/.test(arg)));
    const root = `/tmp/propr-sprite-runs/${spritesRunId({ name: 'claude-issue-7-abc' })}`;
    assert.equal(sprite.modes.get(`${root}/store/claude-config/.credentials.json`), 0o600);
    assert.equal(sprite.files.has(`${root}/env`), false, 'the launcher deletes the environment file');
    assert.equal(sprite.files.has('/home/node/.claude/.credentials.json'), false, 'credentials are removed after the run');

    assert.equal(fs.readFileSync(path.join(credentials, '.credentials.json'), 'utf8'), '{"token":"refreshed"}', 'refreshed token written back');
    assert.equal((await handle.readFile(`${WORKSPACE_TRANSPORT_RESULT_DIR}/status`))?.toString(), 'pushed deadbeef\n');
    assert.equal(await handle.readFile(`${WORKSPACE_TRANSPORT_RESULT_DIR}/result.bundle`), null);
    assert.equal(await handle.readFile('/etc/passwd'), null);
    for (const key of ['wakeMs', 'setupMs', 'credentialSyncMs', 'cloneMs', 'totalMs', 'credentialWriteBackMs'] as const) {
        assert.equal(typeof handle.timings[key], 'number', `${key} measured`);
    }
    assert.equal(handle.timings.created, true);
    await handle.release();
    assert.equal([...sprite.files.keys()].some(file => file.startsWith(`${root}/`)), false, 'release removes the run directory');

    assert.deepEqual(sprite.restored, ['v1'], 'release restores the clean checkpoint');

    // The next run on the same Sprite is already clean: no restore at startup, no new provisioning.
    const next = runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-8-def' }), { timeout: 10_000 });
    assert.equal((await next.wait()).exitCode, 0);
    assert.deepEqual(sprite.restored, ['v1']);
    assert.equal(next.timings.restoreMs, undefined);
    assert.equal(sprite.calls.filter(call => call.file === 'sudo' && call.args.includes('env')).length, 1);
    await next.release();
    assert.deepEqual(sprite.restored, ['v1', 'v1']);
});

function antigravitySpec(source: string, name: string) {
    const spec = new AgentRunSpecBuilder({
        agentType: 'antigravity', image: 'propr/agent:test', name, stdin: true, user: '0:0',
        network: agentRunNetwork('bridge'), security: {},
        workspace: { hostPath: '/tmp/worktree', containerPath: '/home/node/workspace', readOnly: false },
    })
        .credentialBind(source, '/home/node/.gemini-source', true, { provider: 'antigravity', store: 'config', perRun: true })
        .env('PROPR_EPHEMERAL_STATE', '1')
        .env('PROPR_ANTIGRAVITY_SOURCE_CONFIG', '/home/node/.gemini-source')
        .command('agy', '--print', '-')
        .build();
    spec.repoSetup = { agentType: 'antigravity', shell: '/bin/bash', script: 'setup-wrapper', providerEntrypoint: '/home/node/antigravity-entrypoint.sh', env: [] };
    spec.workspace = {
        ...spec.workspace, mode: 'clone',
        clone: { remote: 'https://github.com/o/r.git', baseRef: 'refs/propr/runs/x/base', baseCommit: 'abc', branch: 'b', resultRef: 'refs/propr/runs/x/result', resultDir: WORKSPACE_TRANSPORT_RESULT_DIR, script: CLONE_SCRIPT },
    };
    return spec;
}

function antigravityStore(): string {
    const dir = tempDir('propr-sprites-antigravity-');
    fs.mkdirSync(path.join(dir, 'antigravity-cli'));
    fs.writeFileSync(path.join(dir, 'antigravity-cli', 'antigravity-oauth-token'), '{"token":"agy"}', { mode: 0o600 });
    return dir;
}

/** What an Antigravity run leaves behind like the real one: the clone (with .git), the result bundle and the disposable HOME's token. */
const leaveRunData: FakeAgent = async context => {
    context.files.set('/home/node/workspace/.git/HEAD', Buffer.from('ref: refs/heads/b\n'));
    context.files.set('/home/node/workspace/hello-antigravity.txt', Buffer.from('hello\n'));
    context.files.set(`${WORKSPACE_TRANSPORT_RESULT_DIR}/result.bundle`, Buffer.from('bundle'));
    context.files.set(`${WORKSPACE_TRANSPORT_RESULT_DIR}/status`, Buffer.from('bundled\n'));
    context.files.set('/tmp/propr-antigravity-home/.gemini/antigravity-cli/antigravity-oauth-token', Buffer.from('{"token":"agy"}'));
    context.write('stdout', 'done\n');
    return 0;
};

const RUN_DATA = ['/home/node/workspace/', `${WORKSPACE_TRANSPORT_RESULT_DIR}/`, '/tmp/propr-antigravity-home/', '/tmp/propr-sprite-runs/claude', '/tmp/propr-sprite-runs/antigravity', '/home/node/.gemini-source/'];
const runDataOn = (files: Iterable<string>) => [...files].filter(file => RUN_DATA.some(prefix => file.startsWith(prefix)));

test('Antigravity runs on a Sprite, and release() restores the clean checkpoint so no run data survives', async () => {
    const client = new FakeSpritesClient();
    let argv: string[] = [];
    client.configureSprite = sprite => {
        sprite.agent = async context => {
            argv = context.argv;
            assert.equal(context.files.get('/home/node/.gemini-source/antigravity-cli/antigravity-oauth-token')?.toString(), '{"token":"agy"}');
            return leaveRunData(context);
        };
    };
    const runtime = runtimeFor(client);
    const handle = runtime.start(antigravitySpec(antigravityStore(), 'antigravity-issue-20'), { timeout: 10_000, stdinData: 'prompt' });
    const result = await handle.wait();
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'done\n');
    assert.deepEqual(argv.slice(-5), ['setup-wrapper', '/home/node/antigravity-entrypoint.sh', 'agy', '--print', '-']);
    assert.equal((await handle.readFile(`${WORKSPACE_TRANSPORT_RESULT_DIR}/result.bundle`))?.toString(), 'bundle');

    const sprite = client.sprites.get('propr-w1-0')!;
    assert.ok(runDataOn(sprite.files.keys()).length > 0, 'the run left data on the Sprite before release');
    await handle.release();
    const checkpoint = sprite.snapshots.get('v1')!;
    const survivors = [...sprite.files.keys()].filter(file => !checkpoint.has(file));
    assert.deepEqual(survivors, ['/tmp/propr-sprite-runs/.clean'], 'nothing outside the checkpoint survives release() except the clean marker');
    assert.deepEqual(runDataOn(sprite.files.keys()), []);
    assert.equal(await handle.readFile(`${WORKSPACE_TRANSPORT_RESULT_DIR}/result.bundle`), null);

    // The marker is single-use: the next run starts without a restore and consumes it.
    client.configureSprite = () => undefined;
    sprite.agent = async context => {
        assert.equal(context.files.has('/tmp/propr-sprite-runs/.clean'), false);
        return leaveRunData(context);
    };
    const next = runtime.start(antigravitySpec(antigravityStore(), 'antigravity-issue-21'), { timeout: 10_000 });
    assert.equal((await next.wait()).exitCode, 0);
    assert.equal(next.timings.restoreMs, undefined);
    await next.release();
    assert.deepEqual(sprite.restored, ['v1', 'v1']);
    assert.deepEqual(runDataOn(sprite.files.keys()), []);
});

test('without checkpoint restore, release() removes the workspace, the result and the Antigravity HOME', async () => {
    const client = new FakeSpritesClient();
    client.configureSprite = sprite => { sprite.agent = leaveRunData; };
    const runtime = runtimeFor(client, { PROPR_SPRITES_RESTORE_CHECKPOINT: 'false' });
    const handle = runtime.start(antigravitySpec(antigravityStore(), 'antigravity-issue-22'), { timeout: 10_000 });
    assert.equal((await handle.wait()).exitCode, 0);
    const sprite = client.sprites.get('propr-w1-0')!;
    await handle.release();
    assert.deepEqual(sprite.restored, []);
    assert.deepEqual(runDataOn(sprite.files.keys()), [], 'no repository code, bundle or OAuth token stays on the Sprite');
    const scrub = sprite.calls.find(call => call.args.includes('propr-scrub'))!;
    for (const target of ['/home/node/workspace', WORKSPACE_TRANSPORT_RESULT_DIR, '/tmp/propr-antigravity-home']) assert.ok(scrub.args.includes(target), target);
});

test('a failed checkpoint restore at release falls back to removing the run data', async () => {
    const client = new FakeSpritesClient();
    client.configureSprite = sprite => {
        sprite.agent = leaveRunData;
    };
    const runtime = runtimeFor(client);
    const handle = runtime.start(antigravitySpec(antigravityStore(), 'antigravity-issue-23'), { timeout: 10_000 });
    assert.equal((await handle.wait()).exitCode, 0);
    const sprite = client.sprites.get('propr-w1-0')!;
    sprite.restoreCheckpoint = async () => { throw new Error('restore unavailable'); };
    await handle.release();
    assert.deepEqual(runDataOn(sprite.files.keys()), []);
    assert.equal(sprite.files.has('/tmp/propr-sprite-runs/.clean'), false, 'a Sprite that was not restored is not marked clean');
});

test('a dropped output connection resumes from the received bytes without losing or repeating output', async () => {
    const client = new FakeSpritesClient();
    client.configureSprite = sprite => {
        sprite.dropFollowersOnce = true;
        sprite.agent = async context => {
            context.write('stdout', 'first\n');
            await new Promise(resolve => setTimeout(resolve, 40));
            context.write('stdout', 'second\n');
            context.write('stderr', 'err\n');
            return 3;
        };
    };
    const handle = runtimeFor(client).start(cloneSpec(claudeStore(), { name: 'claude-issue-9' }), { timeout: 10_000 });
    const result = await handle.wait();
    assert.equal(result.stdout, 'first\nsecond\n');
    assert.equal(result.stderr, 'err\n');
    assert.equal(result.exitCode, 3);
    await handle.release();
});

test('a Sprite that goes cold under the run fails clearly instead of hanging', async () => {
    const client = new FakeSpritesClient();
    client.configureSprite = sprite => {
        sprite.agent = async () => {
            sprite.status = 'cold';
            sprite.keepAwakeFails = true;
            await new Promise(() => undefined);
            return 0;
        };
    };
    const handle = runtimeFor(client).start(cloneSpec(claudeStore(), { name: 'claude-issue-10' }), { timeout: 60_000 });
    await assert.rejects(handle.wait(), (error: Error) => error instanceof SpritesRunInterruptedError && /went cold/.test(error.message));
    await handle.release();
});

test('the deadline stops the run through its launcher and keeps partial output', async () => {
    const client = new FakeSpritesClient();
    client.configureSprite = sprite => {
        sprite.agent = async context => {
            context.write('stdout', 'partial\n');
            await context.terminated;
            return 143;
        };
    };
    const handle = runtimeFor(client).start(cloneSpec(claudeStore(), { name: 'claude-issue-11' }), { timeout: 300, preserveOutputOnTimeout: true });
    const result = await handle.wait();
    assert.equal(result.timedOut, true);
    assert.equal(result.stdout, 'partial\n');
    assert.match(result.stderr, /timed out after 300ms/);
    assert.deepEqual(client.sprites.get('propr-w1-0')!.signals, ['TERM']);
    await handle.release();
});

test('stop() through the run handle rejects wait() with the stop error', async () => {
    const client = new FakeSpritesClient();
    client.configureSprite = sprite => { sprite.agent = async context => { await context.terminated; return 143; }; };
    const handle = runtimeFor(client).start(cloneSpec(claudeStore(), { name: 'claude-issue-12' }), { timeout: 60_000 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const waited = handle.wait().catch(error => error);
    await handle.stop();
    assert.equal((await waited).name, 'AgentRunStoppedError');
    await handle.release();
});

test('a restarted worker reattaches to the run on its Sprite and recovers the full output', async () => {
    const client = new FakeSpritesClient();
    let finish!: () => void;
    const released = new Promise<void>(resolve => { finish = resolve; });
    client.configureSprite = sprite => {
        sprite.agent = async context => {
            context.write('stdout', 'before restart\n');
            await released;
            context.write('stdout', 'after restart\n');
            return 0;
        };
    };
    const spec = cloneSpec(claudeStore(), { name: 'claude-issue-13' });
    const first = runtimeFor(client).start(spec, { timeout: 60_000 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const restarted = runtimeFor(client);
    const attached = await restarted.attach(spec, { timeout: 60_000 });
    assert.ok(attached, 'the run is found on the worker Sprite');
    finish();
    const result = await attached.wait();
    assert.equal(result.stdout, 'before restart\nafter restart\n');
    assert.equal(result.exitCode, 0);
    assert.equal(await restarted.attach(cloneSpec(claudeStore(), { name: 'claude-issue-unknown' })), null);
    await first.wait();
    await Promise.all([first.release(), attached.release()]);
});

test('a Sprite running another process\'s launcher is skipped for the next slot', async () => {
    const client = new FakeSpritesClient();
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    client.configureSprite = sprite => { sprite.agent = async () => { await held; return 0; }; };
    const first = runtimeFor(client).start(cloneSpec(claudeStore(), { name: 'claude-issue-14' }), { timeout: 60_000 });
    await new Promise(resolve => setTimeout(resolve, 50));
    // A second ProPR process on the same host: its own pool, the same worker id.
    client.configureSprite = sprite => { sprite.agent = async () => 0; };
    const second = runtimeFor(client).start(cloneSpec(claudeStore(), { name: 'claude-issue-15' }), { timeout: 60_000 });
    assert.equal((await second.wait()).exitCode, 0);
    assert.deepEqual(client.created, ['propr-w1-0', 'propr-w1-1']);
    finish();
    await first.wait();
    await Promise.all([first.release(), second.release()]);
});

test('Docker-only preparation and sweeps are skipped when no agent runs on Docker', async () => {
    assert.equal(dockerAgentRuntimeInUse([], {}), true);
    assert.equal(dockerAgentRuntimeInUse([], { PROPR_AGENT_RUNTIME: 'sprites' }), false);
    assert.equal(dockerAgentRuntimeInUse([{ enabled: true, runtime: 'docker' }], { PROPR_AGENT_RUNTIME: 'sprites' }), true);
    assert.equal(dockerAgentRuntimeInUse([{ enabled: true }, { enabled: false, runtime: 'docker' }], { PROPR_AGENT_RUNTIME: 'sprites' }), false);
    const missingDocker = async () => { throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }); };
    assert.deepEqual(await runningContainerMountSources(missingDocker, { PROPR_AGENT_RUNTIME: 'sprites' }), []);
    await assert.rejects(runningContainerMountSources(missingDocker, {}), /ENOENT/);
    const unreachable = async () => ({ exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' });
    assert.deepEqual(await runningContainerMountSources(unreachable, { PROPR_AGENT_RUNTIME: 'sprites' }), []);
    await assert.rejects(runningContainerMountSources(unreachable, {}), /docker ps failed/);
});
