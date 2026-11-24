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

function runtimeFor(client: FakeSpritesClient, environment: Record<string, string> = {}, dependencies: { setupHash?: string; stopSettlementMs?: number } = {}) {
    const env: NodeJS.ProcessEnv = {
        PROPR_SPRITES_TOKEN: 'org-token', PROPR_SPRITES_WORKER_ID: 'w1', PROPR_SPRITES_REGION: 'ord',
        PROPR_SPRITES_KEEP_AWAKE_INTERVAL_MS: '20', PROPR_AGENT_CREDENTIAL_RUN_DIR: tempDir('propr-sprites-locks-'), ...environment,
    };
    const { setupHash } = dependencies;
    const setupBundle = setupHash ? (() => { const bundle = readSpritesSetupBundle(); return () => ({ ...bundle, hash: setupHash }); })() : undefined;
    return new SpritesRuntime({
        createClient: async () => client as never, environment: env, reconnectDelayMs: 5, launcherSettleMs: 300,
        ...(setupBundle ? { setupBundle } : {}), ...(dependencies.stopSettlementMs ? { stopSettlementMs: dependencies.stopSettlementMs } : {}),
    });
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
    // The provider entrypoint root runs after the setup hook is the root-owned copy, not the agent-writable /home/node one.
    assert.deepEqual(renderSpritesArgv(spec), ['/bin/bash', '-lc', CLONE_SCRIPT, 'setup-wrapper', '/opt/propr/entrypoints/claude-entrypoint.sh', 'claude', '-p', '-', '--output-format', 'stream-json']);
    const environment = resolveSpritesEnvironment(spec, { PROPR_WORKSPACE_GIT_TOKEN: 'repo-token' });
    assert.equal(environment.get('PROPR_WORKSPACE_GIT_TOKEN'), 'repo-token');
    assert.equal(environment.get('PROPR_REPO_SETUP'), '1');
    assert.equal(environment.get('HOME'), '/root');
    assert.equal(environment.has('UNSET_IN_LAUNCH'), false);
    assert.match(environment.get('PATH')!, /^\/opt\/propr\/bin:/);
    assert.ok(!environment.get('PATH')!.split(':').some(directory => directory.startsWith('/home/') || directory.startsWith('/tmp/')), 'root resolves commands only through directories the agent cannot write');
    assert.match(resolveSpritesEnvironment({ ...spec, user: '1000:1000' }, {}).get('PATH')!, /:\/home\/node\/\.local\/bin:/, 'a run started as node keeps its own ~/.local/bin');
    for (const exposed of ['/home/node/custom-entrypoint.sh', '/tmp/propr-entrypoint.sh', '/home/node/../node/claude-entrypoint.sh/../evil.sh', './claude-entrypoint.sh']) {
        assert.throws(() => renderSpritesArgv({ ...spec, repoSetup: { ...spec.repoSetup!, providerEntrypoint: exposed } }), /will not run .* as root/, exposed);
    }
    assert.throws(() => renderSpritesArgv({ ...spec, repoSetup: { ...spec.repoSetup!, shell: '/home/node/.local/bin/bash' } }), /will not run \/home\/node\/\.local\/bin\/bash as root/);
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
    assert.deepEqual(argv.slice(-5), ['setup-wrapper', '/opt/propr/entrypoints/antigravity-entrypoint.sh', 'agy', '--print', '-']);
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

test('a Sprite that goes cold under the run fails clearly instead of hanging, and keeps the live credential copy it could not export', async () => {
    const client = new FakeSpritesClient();
    const credentials = claudeStore();
    client.configureSprite = sprite => {
        sprite.agent = async context => {
            context.files.set('/home/node/.claude/.credentials.json', Buffer.from('{"token":"rotated"}'));
            sprite.status = 'cold';
            sprite.keepAwakeFails = true;
            await new Promise(() => undefined);
            return 0;
        };
    };
    const runtime = runtimeFor(client, { PROPR_SPRITES_MAX_SPRITES: '1' });
    const handle = runtime.start(cloneSpec(credentials, { name: 'claude-issue-10' }), { timeout: 60_000 });
    await assert.rejects(handle.wait(), (error: Error) => error instanceof SpritesRunInterruptedError && /went cold/.test(error.message));
    await handle.release();
    const sprite = client.sprites.get('propr-w1-0')!;
    const root = `/tmp/propr-sprite-runs/${spritesRunId({ name: 'claude-issue-10' })}`;
    // The launcher died before it returned the token: no exit status, nothing in returned/.
    assert.equal(sprite.files.get('/home/node/.claude/.credentials.json')?.toString(), '{"token":"rotated"}', 'the live copy holding the rotated token is kept');
    assert.equal(fs.readFileSync(path.join(credentials, '.credentials.json'), 'utf8'), '{"token":"old"}', 'nothing unconfirmed is written back');
    const obligation = JSON.parse(sprite.files.get(`${root}/credentials-retained`)!.toString());
    assert.equal(obligation.reason, 'export-unconfirmed');
    assert.deepEqual(obligation.liveCopies, ['/home/node/.claude']);
    assert.deepEqual(sprite.restored, [], 'the Sprite is not restored over the live copy');
    sprite.status = 'warm';
    sprite.keepAwakeFails = false;
    await assert.rejects(runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-10b' }), { timeout: 10_000 }).wait(), /awaiting recovery/);
    assert.equal(sprite.files.get('/home/node/.claude/.credentials.json')?.toString(), '{"token":"rotated"}');
});

test('output lost while the launcher still runs: write-back waits for the launcher to export the rotated token', async () => {
    const client = new FakeSpritesClient();
    const credentials = claudeStore();
    client.configureSprite = sprite => {
        sprite.agent = async context => {
            context.files.set('/home/node/.claude/.credentials.json', Buffer.from('{"token":"rotated"}'));
            sprite.dropFollowersAlways = true;
            await context.terminated;
            await sleep(150); // still handling TERM when supervision gives up on the output
            return 143;
        };
    };
    const handle = runtimeFor(client).start(cloneSpec(credentials, { name: 'claude-issue-16' }), { timeout: 60_000 });
    await assert.rejects(handle.wait(), (error: Error) => error instanceof SpritesRunInterruptedError && /could not reconnect/.test(error.message));
    assert.equal(fs.readFileSync(path.join(credentials, '.credentials.json'), 'utf8'), '{"token":"rotated"}', 'the exported token reached the canonical store');
    const sprite = client.sprites.get('propr-w1-0')!;
    const root = `/tmp/propr-sprite-runs/${spritesRunId({ name: 'claude-issue-16' })}`;
    assert.equal(sprite.files.has(`${root}/credentials-retained`), false, 'a confirmed write-back lifts the run\'s recovery obligation');
    await handle.release();
    assert.deepEqual(sprite.restored, ['v1']);
});

test('the run\'s credential recovery obligation is durable on the Sprite from upload until its write-back', async () => {
    const client = new FakeSpritesClient();
    const root = `/tmp/propr-sprite-runs/${spritesRunId({ name: 'claude-issue-17' })}`;
    let duringRun: unknown;
    client.configureSprite = sprite => {
        sprite.agent = async context => { duringRun = JSON.parse(context.files.get(`${root}/credentials-retained`)!.toString()); return 0; };
    };
    const handle = runtimeFor(client).start(cloneSpec(claudeStore(), { name: 'claude-issue-17' }), { timeout: 10_000 });
    assert.equal((await handle.wait()).exitCode, 0);
    // A worker that stopped here would leave the Sprite quarantined for every process instead of restorable over the token.
    assert.equal((duringRun as { reason: string }).reason, 'pending-write-back');
    assert.equal(client.sprites.get('propr-w1-0')!.files.has(`${root}/credentials-retained`), false);
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

test('a queued run copies the credentials current when it gets its Sprite, not the ones from before it waited', async () => {
    const client = new FakeSpritesClient();
    const credentials = claudeStore();
    let finishFirst!: () => void;
    const firstMayFinish = new Promise<void>(resolve => { finishFirst = resolve; });
    const received: string[] = [];
    client.configureSprite = sprite => {
        sprite.agent = async context => {
            received.push(context.files.get('/home/node/.claude/.credentials.json')!.toString());
            if (received.length === 1) {
                await firstMayFinish;
                context.files.set('/home/node/.claude/.credentials.json', Buffer.from('{"token":"refreshed-by-first"}'));
            }
            return 0;
        };
    };
    const runtime = runtimeFor(client, { PROPR_SPRITES_MAX_SPRITES: '1' });
    const first = runtime.start(cloneSpec(credentials, { name: 'claude-issue-90' }), { timeout: 10_000 });
    for (let i = 0; i < 200 && received.length === 0; i++) await sleep(5);
    const second = runtime.start(cloneSpec(credentials, { name: 'claude-issue-91' }), { timeout: 10_000 });
    await sleep(30); // queued for the only Sprite
    finishFirst();
    assert.equal((await first.wait()).exitCode, 0);
    assert.equal(fs.readFileSync(path.join(credentials, '.credentials.json'), 'utf8'), '{"token":"refreshed-by-first"}');
    await first.release();
    assert.equal((await second.wait()).exitCode, 0);
    assert.deepEqual(received, ['{"token":"old"}', '{"token":"refreshed-by-first"}']);
    assert.equal(fs.readFileSync(path.join(credentials, '.credentials.json'), 'utf8'), '{"token":"refreshed-by-first"}');
    await second.release();
});

/** A run whose worker restarts mid-run: the original handle is gone (it writes nothing back), a new runtime reattaches. */
async function reattachedRun(client: FakeSpritesClient, credentials: string, name: string, { onRunning, agentWrites }: { onRunning?: (sprite: ReturnType<FakeSpritesClient['sprite']>, root: string) => void; agentWrites?: string } = {}) {
    let finish!: () => void;
    const released = new Promise<void>(resolve => { finish = resolve; });
    let running = false;
    client.configureSprite = sprite => {
        sprite.agent = async context => {
            running = true;
            await released;
            if (agentWrites) context.files.set('/home/node/.claude/.credentials.json', Buffer.from(agentWrites));
            return 0;
        };
    };
    const spec = cloneSpec(credentials, { name });
    const first = runtimeFor(client).start(spec, { timeout: 60_000 });
    for (let i = 0; i < 200 && !running; i++) await sleep(5);
    // The interrupted worker's in-memory state (its baseline among it) is lost with it.
    Reflect.set(first, 'credentials', undefined);
    const sprite = client.sprites.get('propr-w1-0')!;
    const root = `/tmp/propr-sprite-runs/${spritesRunId({ name })}`;
    onRunning?.(sprite, root);
    const attached = await runtimeFor(client).attach(spec, { timeout: 60_000 });
    assert.ok(attached);
    finish();
    assert.equal((await attached.wait()).exitCode, 0);
    await first.wait();
    return { first, attached, sprite, root };
}

test('a reattached run recovers the baseline it was launched with: an unchanged stale token never replaces a newer canonical one', async () => {
    const client = new FakeSpritesClient();
    const credentials = claudeStore();
    const canonical = path.join(credentials, '.credentials.json');
    const receivedAt = new Date(Date.now() - 60_000);
    fs.utimesSync(canonical, receivedAt, receivedAt);
    const receivedMtimeMs = Math.floor(fs.statSync(canonical).mtimeMs);
    const { first, attached, sprite, root } = await reattachedRun(client, credentials, 'claude-issue-92', {
        onRunning: (running, runRoot) => {
            // The copy keeps the canonical modification time, not the upload's.
            assert.equal(running.mtimes.get('/home/node/.claude/.credentials.json'), receivedMtimeMs);
            assert.ok(running.files.has(`${runRoot}/credential-baseline.json`), 'the baseline is persisted with the run');
            // Another run on the account refreshed the canonical token meanwhile; its time even reads older (clock skew between hosts).
            fs.writeFileSync(canonical, '{"token":"newer-canonical"}');
            const skewed = new Date(receivedAt.getTime() - 30_000);
            fs.utimesSync(canonical, skewed, skewed);
        },
    });
    assert.equal(fs.readFileSync(canonical, 'utf8'), '{"token":"newer-canonical"}', 'the unchanged stale copy is recognised as unchanged');
    assert.equal(sprite.files.has(`${root}/credentials-retained`), false, 'nothing is left to recover');
    await Promise.all([first.release(), attached.release()]);

    // A token the run did refresh is still written back after reattachment.
    const refreshedStore = claudeStore();
    const refreshed = await reattachedRun(new FakeSpritesClient(), refreshedStore, 'claude-issue-93', { agentWrites: '{"token":"refreshed-on-sprite"}' });
    assert.equal(fs.readFileSync(path.join(refreshedStore, '.credentials.json'), 'utf8'), '{"token":"refreshed-on-sprite"}');
    await Promise.all([refreshed.first.release(), refreshed.attached.release()]);
});

test('a reattached run whose baseline cannot be recovered keeps its returned tokens for recovery instead of guessing', async () => {
    const client = new FakeSpritesClient();
    const credentials = claudeStore();
    const canonical = path.join(credentials, '.credentials.json');
    const { first, attached, sprite, root } = await reattachedRun(client, credentials, 'claude-issue-94', {
        agentWrites: '{"token":"refreshed-on-sprite"}',
        onRunning: (running, runRoot) => {
            running.files.delete(`${runRoot}/credential-baseline.json`);
            fs.writeFileSync(canonical, '{"token":"newer-canonical"}');
        },
    });
    assert.equal(fs.readFileSync(canonical, 'utf8'), '{"token":"newer-canonical"}');
    assert.equal(sprite.files.get(`${root}/returned/claude-config/.credentials.json`)?.toString(), '{"token":"refreshed-on-sprite"}', 'the returned token stays in the run directory');
    assert.equal(JSON.parse(sprite.files.get(`${root}/credentials-retained`)!.toString()).reason, 'baseline-unknown');
    first.retain(); // the interrupted worker never releases its run
    await attached.release();
    assert.ok(sprite.files.has(`${root}/credentials-retained`), 'the Sprite stays quarantined');
    assert.ok(sprite.files.has(`${root}/returned/claude-config/.credentials.json`));
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
    const noAgents = async () => [];
    assert.deepEqual(await runningContainerMountSources(missingDocker, { PROPR_AGENT_RUNTIME: 'sprites' }, noAgents), []);
    await assert.rejects(runningContainerMountSources(missingDocker, {}, noAgents), /ENOENT/);
    const unreachable = async () => ({ exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' });
    assert.deepEqual(await runningContainerMountSources(unreachable, { PROPR_AGENT_RUNTIME: 'sprites' }, noAgents), []);
    await assert.rejects(runningContainerMountSources(unreachable, {}, noAgents), /docker ps failed/);
});

test('worktree reclamation honours per-agent runtimes: Sprites selected by every enabled agent needs no Docker', async () => {
    const missingDocker = async () => { throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }); };
    const unreachable = async () => ({ exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' });
    // PROPR_AGENT_RUNTIME unset (Docker), but each enabled agent selects Sprites itself, as image preparation sees it.
    const perAgentSprites = async () => [{ enabled: true, runtime: 'sprites' }, { enabled: true, runtime: ' Sprites ' }, { enabled: false, runtime: 'docker' }];
    assert.equal(dockerAgentRuntimeInUse(await perAgentSprites(), {}), false);
    assert.deepEqual(await runningContainerMountSources(missingDocker, {}, perAgentSprites), []);
    assert.deepEqual(await runningContainerMountSources(unreachable, {}, perAgentSprites), []);
    // Docker keeps its authority when any enabled agent selects it (itself or through the default), or the agents cannot be read.
    const oneDocker = async () => [{ enabled: true, runtime: 'sprites' }, { enabled: true, runtime: 'docker' }];
    await assert.rejects(runningContainerMountSources(unreachable, { PROPR_AGENT_RUNTIME: 'sprites' }, oneDocker), /docker ps failed/);
    const oneDefault = async () => [{ enabled: true, runtime: 'sprites' }, { enabled: true }];
    await assert.rejects(runningContainerMountSources(missingDocker, {}, oneDefault), /ENOENT/);
    const unreadable = async () => { throw new Error('database unavailable'); };
    await assert.rejects(runningContainerMountSources(unreachable, { PROPR_AGENT_RUNTIME: 'sprites' }, unreadable), /docker ps failed/);
    const malformed = async () => [null] as never;
    await assert.rejects(runningContainerMountSources(missingDocker, { PROPR_AGENT_RUNTIME: 'sprites' }, malformed), /ENOENT/);
    // Any other Docker failure still disables reclamation, and a reachable Docker never needs the agents.
    await assert.rejects(runningContainerMountSources(async () => ({ exitCode: 1, stdout: '', stderr: 'permission denied' }), {}, perAgentSprites), /docker ps failed/);
    let loads = 0;
    const counted = async () => { loads++; return []; };
    assert.deepEqual(await runningContainerMountSources(async () => ({ exitCode: 0, stdout: '', stderr: '' }), {}, counted), []);
    assert.equal(loads, 0);
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const scrubs = (sprite: { calls: Array<{ args: string[] }> }) => sprite.calls.filter(call => call.args.includes('propr-scrub')).length;

test('credentials retained after a failed write-back quarantine the Sprite: no restore, no reuse, until the run directory is deleted', async () => {
    const client = new FakeSpritesClient();
    const credentials = claudeStore();
    client.configureSprite = sprite => {
        sprite.agent = async context => {
            context.files.set('/home/node/.claude/.credentials.json', Buffer.from('{"token":"rotated"}'));
            fs.chmodSync(credentials, 0o500); // the canonical store cannot take the refreshed token
            return 0;
        };
    };
    const runtime = runtimeFor(client, { PROPR_SPRITES_MAX_SPRITES: '1' });
    const first = runtime.start(cloneSpec(credentials, { name: 'claude-issue-30' }), { timeout: 10_000 });
    try {
        assert.equal((await first.wait()).exitCode, 0);
    } finally {
        fs.chmodSync(credentials, 0o700);
    }
    await first.release();
    const sprite = client.sprites.get('propr-w1-0')!;
    const root = `/tmp/propr-sprite-runs/${spritesRunId({ name: 'claude-issue-30' })}`;
    const retainedToken = `${root}/returned/claude-config/.credentials.json`;
    assert.equal(sprite.files.get(retainedToken)?.toString(), '{"token":"rotated"}');
    assert.ok(sprite.files.has(`${root}/credentials-retained`), 'the recovery obligation is persisted on the Sprite');
    assert.deepEqual(sprite.restored, [], 'release does not restore over the retained credentials');

    // Another run (this process or another one) must not restore the Sprite or run on it.
    sprite.agent = async () => 0;
    await assert.rejects(runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-31' }), { timeout: 10_000 }).wait(), /holds credentials awaiting recovery/);
    await assert.rejects(runtimeFor(client, { PROPR_SPRITES_MAX_SPRITES: '1' }).start(cloneSpec(claudeStore(), { name: 'claude-issue-32' }), { timeout: 10_000 }).wait(), /awaiting recovery/);
    assert.deepEqual(sprite.restored, []);
    assert.equal(sprite.files.get(retainedToken)?.toString(), '{"token":"rotated"}', 'the only rotated token survives the next acquisitions');
    assert.deepEqual(sprite.sessions, [root]);

    // A second slot keeps the worker running meanwhile.
    const wider = runtimeFor(client, { PROPR_SPRITES_MAX_SPRITES: '2' });
    const elsewhere = wider.start(cloneSpec(claudeStore(), { name: 'claude-issue-33' }), { timeout: 10_000 });
    assert.equal((await elsewhere.wait()).exitCode, 0);
    assert.equal(elsewhere.timings.created, true);
    await elsewhere.release();

    // Once the operator recovered the token and deleted the directory, the Sprite is used again.
    await sprite.filesystem().rm(root);
    const after = runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-34' }), { timeout: 10_000 });
    assert.equal((await after.wait()).exitCode, 0);
    assert.deepEqual(sprite.restored, ['v1']);
    await after.release();
});

test('a failed preparation cleans and frees its Sprite once; a later release() never touches the next run', async () => {
    const client = new FakeSpritesClient();
    let finishSecond!: () => void;
    const secondHeld = new Promise<void>(resolve => { finishSecond = resolve; });
    let failUpload = true;
    client.configureSprite = sprite => {
        const filesystem = sprite.filesystem.bind(sprite);
        sprite.filesystem = () => {
            const fsApi = filesystem();
            return { ...fsApi, writeFile: async (file: string, data: string | Buffer, options?: { mode?: number }) => {
                if (failUpload && file.endsWith('/launch.sh')) { failUpload = false; throw new Error('upload failed'); }
                return fsApi.writeFile(file, data, options);
            } };
        };
        sprite.agent = async context => { await secondHeld; context.write('stdout', 'second done\n'); return 0; };
    };
    const runtime = runtimeFor(client, { PROPR_SPRITES_MAX_SPRITES: '1' });
    const first = runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-40' }), { timeout: 10_000 });
    const second = runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-41' }), { timeout: 10_000 });
    await assert.rejects(first.wait(), /upload failed/);
    const sprite = client.sprites.get('propr-w1-0')!;
    for (let i = 0; i < 200 && sprite.sessions.length === 0; i++) await sleep(5);
    assert.equal(sprite.sessions.length, 1, 'the queued run got the Sprite');
    const before = { restored: sprite.restored.length, scrubs: scrubs(sprite), files: sprite.files.size };
    await first.release();
    assert.equal(sprite.restored.length, before.restored, 'the failed run does not restore the Sprite under the next run');
    assert.equal(scrubs(sprite), before.scrubs);
    const secondRoot = `/tmp/propr-sprite-runs/${spritesRunId({ name: 'claude-issue-41' })}`;
    assert.ok(sprite.files.has(`${secondRoot}/launch.sh`), 'the next run keeps its files');
    finishSecond();
    assert.equal((await second.wait()).stdout, 'second done\n');
    await second.release();
});

test('the deadline covers queueing for a Sprite: an expired run settles as timed out and never starts', async () => {
    const client = new FakeSpritesClient();
    let finishFirst!: () => void;
    const firstHeld = new Promise<void>(resolve => { finishFirst = resolve; });
    client.configureSprite = sprite => { sprite.agent = async () => { await firstHeld; return 0; }; };
    const runtime = runtimeFor(client, { PROPR_SPRITES_MAX_SPRITES: '1' });
    const first = runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-50' }), { timeout: 60_000 });
    await sleep(50);
    const started = Date.now();
    const queued = runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-51' }), { timeout: 200, preserveOutputOnTimeout: true });
    const result = await queued.wait();
    assert.ok(Date.now() - started < 2_000, 'settled at its deadline while the Sprite was still busy');
    assert.equal(result.timedOut, true);
    assert.match(result.stderr, /timed out after 200ms/);
    await assert.rejects(runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-52' }), { timeout: 100 }).wait(), /timed out after 100ms/);
    finishFirst();
    await first.wait();
    await Promise.all([first.release(), queued.release()]);
    const sprite = client.sprites.get('propr-w1-0')!;
    assert.deepEqual(sprite.sessions, [`/tmp/propr-sprite-runs/${spritesRunId({ name: 'claude-issue-50' })}`], 'expired runs never start a session');
});

test('the deadline covers first-time setup: the run settles on time and its Sprite is freed only after the setup finished', async () => {
    const client = new FakeSpritesClient();
    let setupDone = false;
    client.configureSprite = sprite => {
        const execFile = sprite.execFile.bind(sprite);
        sprite.execFile = async (file: string, args: string[] = []) => {
            if (file === 'sudo' && args.includes('env')) { await sleep(400); setupDone = true; }
            return execFile(file, args);
        };
    };
    const runtime = runtimeFor(client, { PROPR_SPRITES_MAX_SPRITES: '1' });
    const slow = runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-55' }), { timeout: 150 });
    await assert.rejects(slow.wait(), /timed out after 150ms/);
    assert.equal(setupDone, false, 'settled before the setup finished');
    const next = runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-56' }), { timeout: 10_000 });
    await slow.release();
    assert.equal(setupDone, true, 'release waits for the abandoned setup before cleaning the Sprite');
    assert.equal((await next.wait()).exitCode, 0);
    const sprite = client.sprites.get('propr-w1-0')!;
    assert.deepEqual(sprite.sessions, [`/tmp/propr-sprite-runs/${spritesRunId({ name: 'claude-issue-56' })}`]);
    await next.release();
});

test('release() verifies every process of the run is gone before the Sprite is reused, and keeps it otherwise', async () => {
    const client = new FakeSpritesClient();
    client.configureSprite = sprite => { sprite.agent = async () => 0; };
    const runtime = runtimeFor(client, { PROPR_SPRITES_MAX_SPRITES: '1' });
    const first = runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-60' }), { timeout: 10_000 });
    assert.equal((await first.wait()).exitCode, 0);
    const sprite = client.sprites.get('propr-w1-0')!;
    sprite.survivesKill = true;
    await first.release();
    assert.ok(sprite.signals.includes('KILL'), 'release kills the run\'s process boundary');
    assert.deepEqual(sprite.restored, [], 'a Sprite with surviving processes is not cleaned for reuse');
    const keepAlive = setInterval(() => undefined, 50); // the run deadline timer does not hold the process open
    const queued = runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-61' }), { timeout: 200 });
    await assert.rejects(queued.wait(), /timed out after 200ms/, 'its slot stays taken');
    clearInterval(keepAlive);
    assert.equal(sprite.sessions.length, 1);
});

const linuxProcesses = process.platform === 'linux' && fs.existsSync('/proc/self/stat') && fs.existsSync('/usr/bin/setsid');

test('the launcher contains the run\'s processes: KILL takes descendants that ignore TERM or left the session, and exit kills leftovers', { skip: !linuxProcesses }, async t => {
    const { execFileSync, spawn } = await import('node:child_process');
    const { SPRITES_LAUNCHER_SCRIPT, SPRITES_SIGNAL_SCRIPT: signalScript, SPRITES_AGENT_UID_LINE } = await import('../packages/core/src/agents/runtime/sprites/spritesCommand.ts');
    const dir = tempDir('propr-sprites-procs-');
    const launcher = path.join(dir, 'launch.sh');
    // The launcher runs as root on a Sprite; here as the test user (who owns every process it starts). The
    // agent UID is one no process has: the test user may be `node`, and every process of the agent UID is killed.
    const unusedAgentUid = (script: string) => script.replace(SPRITES_AGENT_UID_LINE, 'agent_uid=2147483000');
    const SPRITES_SIGNAL_SCRIPT = unusedAgentUid(signalScript);
    fs.writeFileSync(launcher, unusedAgentUid(SPRITES_LAUNCHER_SCRIPT).replace('[ "$(id -u)" = "0" ]', 'true').replace('id node >/dev/null 2>&1', 'true'));
    const nul = (values: string[]) => values.map(value => `${value}\0`).join('');
    const marker = `propr-${process.pid}-${Date.now()}`;
    const alive = (): string[] => {
        const ps = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
        return ps.split('\n').filter(line => new RegExp(`^\\s*\\d+ sleep 8640[01] ${marker} `).test(line));
    };
    const runDir = (name: string, script: string) => {
        const run = path.join(dir, name);
        fs.mkdirSync(run);
        fs.writeFileSync(path.join(run, 'argv'), nul(['bash', '-c', script]));
        fs.writeFileSync(path.join(run, 'env'), nul([`PATH=${process.env.PATH}`]));
        fs.writeFileSync(path.join(run, 'manifest'), '');
        fs.writeFileSync(path.join(run, 'workdir'), path.join(dir, `${name}-work`));
        fs.writeFileSync(path.join(run, 'user'), 'root');
        return run;
    };
    // sleep's extra argument tags the process (GNU sleep sums its arguments, so both are numbers).
    const stubborn = `trap "" TERM; bash -c 'trap "" TERM; exec -a "sleep 86400 ${marker}" sleep 86400' & setsid bash -c 'trap "" TERM; exec -a "sleep 86401 ${marker}" sleep 86401' & echo started; wait`;
    const run = runDir('stopped', stubborn);
    const child = spawn('bash', [launcher, run], { stdio: 'ignore' });
    const exited = new Promise<number | null>(resolve => child.on('exit', resolve));
    t.after(() => {
        child.kill('SIGKILL');
        for (const line of alive()) process.kill(Number(line.trim().split(' ')[0]), 'SIGKILL');
    });
    for (let i = 0; i < 200 && alive().length < 2; i++) await sleep(25);
    assert.equal(alive().length, 2, 'the agent\'s grandchild and an escaped daemon are running');
    execFileSync('bash', ['-c', SPRITES_SIGNAL_SCRIPT, 'propr-signal', 'TERM', run]);
    await sleep(300);
    assert.equal(alive().length, 2, 'they ignore TERM');
    execFileSync('bash', ['-c', SPRITES_SIGNAL_SCRIPT, 'propr-signal', 'KILL', run]); // throws unless it verified that nothing survived
    assert.deepEqual(alive(), []);
    assert.equal(await exited, 137, 'the launcher finishes normally once its command was killed');
    assert.equal(fs.readFileSync(path.join(run, 'exit-status'), 'utf8'), '137\n');

    const leftovers = runDir('finished', `nohup bash -c 'exec -a "sleep 86400 ${marker}" sleep 86400' >/dev/null 2>&1 & setsid bash -c 'exec -a "sleep 86401 ${marker}" sleep 86401' & sleep 0.3; echo bye`);
    execFileSync('bash', [launcher, leftovers]);
    assert.deepEqual(alive(), [], 'background processes do not outlive the run');
    assert.equal(fs.readFileSync(path.join(leftovers, 'stdout.log'), 'utf8'), 'bye\n');
});

test('run membership includes every process of the agent UID, so a descendant that left the session and cleared its environment is killed', { skip: !linuxProcesses }, async t => {
    const { execFileSync, spawn } = await import('node:child_process');
    const { SPRITES_RUN_MEMBERS_FUNCTIONS, SPRITES_AGENT_UID_LINE, SPRITES_LAUNCHER_SCRIPT } = await import('../packages/core/src/agents/runtime/sprites/spritesCommand.ts');
    const marker = `propr-escape-${process.pid}-${Date.now()}`;
    // What an agent can do with PROPR_SPRITES_RESTORE_CHECKPOINT=false: a new session, no run tag, nothing inherited.
    spawn('setsid', ['-f', 'env', '-i', 'PATH=/usr/bin:/bin', 'bash', '-c', `exec -a "sleep 86402 ${marker}" sleep 86402`], { stdio: 'ignore' });
    const find = () => execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n').find(line => line.includes(`sleep 86402 ${marker}`))?.trim().split(' ')[0];
    let pid: string | undefined;
    for (let i = 0; i < 200 && !(pid = find()); i++) await sleep(10);
    assert.ok(pid, 'the escaped process is running');
    t.after(() => { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ } });
    const escaped = { pid: Number(pid) };
    assert.doesNotMatch(fs.readFileSync(`/proc/${escaped.pid}/environ`, 'utf8'), /PROPR_SPRITES_RUN/);
    // Listing only (never killing): as non-root the "agent UID" can only be the test user's own.
    const members = (agentUidLine: string) => execFileSync('bash', ['-c', `${SPRITES_RUN_MEMBERS_FUNCTIONS.replace(SPRITES_AGENT_UID_LINE, agentUidLine)}\nrun_members /tmp/propr-sprite-runs/escape-test ""`], { encoding: 'utf8' })
        .split('\n').filter(Boolean);
    assert.ok(members(`agent_uid=${process.getuid!()}`).includes(String(escaped.pid)), 'the escaped process is a member through its UID');
    assert.ok(!members('agent_uid=2147483000').includes(String(escaped.pid)), 'without the UID, session and environment tag both miss it');
    assert.ok(!members('agent_uid=0').includes(String(escaped.pid)) && members('agent_uid=0').length === 0, 'root is never the agent UID');
    // The launcher clears leftovers of earlier runs before it installs this run's credentials.
    assert.ok(SPRITES_LAUNCHER_SCRIPT.indexOf('kill_run_members "$run_dir" ""') < SPRITES_LAUNCHER_SCRIPT.indexOf('case "$kind" in'));
});

/** A run that finished but was never released (its worker stopped): its data is still on the Sprite. */
async function unreleasedRun(client: FakeSpritesClient, name: string) {
    client.configureSprite = sprite => {
        sprite.agent = async context => {
            context.files.set('/home/node/workspace/secret.txt', Buffer.from('repository code'));
            context.files.set('/home/node/stray-cache', Buffer.from('previous run data'));
            return 0;
        };
    };
    const handle = runtimeFor(client).start(cloneSpec(claudeStore(), { name }), { timeout: 10_000 });
    assert.equal((await handle.wait()).exitCode, 0);
    handle.retain(); // never released
    client.configureSprite = sprite => { sprite.agent = async () => 0; };
    return client.sprites.get('propr-w1-0')!;
}

const previousRunData = (files: Iterable<string>) => [...files].filter(file => file === '/home/node/workspace/secret.txt' || file === '/home/node/stray-cache' || file.startsWith('/tmp/propr-sprite-runs/claude-issue-70'));

test('a new setup revision provisions from the previous revision\'s clean checkpoint, never from an unreleased run\'s filesystem', async () => {
    const client = new FakeSpritesClient();
    const sprite = await unreleasedRun(client, 'claude-issue-70');
    assert.ok(previousRunData(sprite.files.keys()).length > 0);
    sprite.agent = async () => 0;
    const upgraded = runtimeFor(client, {}, { setupHash: 'feedfacefeedface' }).start(cloneSpec(claudeStore(), { name: 'claude-issue-71' }), { timeout: 10_000 });
    assert.equal((await upgraded.wait()).exitCode, 0);
    assert.deepEqual(sprite.restored, ['v1'], 'restored to the earlier revision\'s baseline before setup');
    const checkpoint = sprite.checkpoints.find(candidate => candidate.comment === 'propr-setup feedfacefeedface')!;
    assert.deepEqual(previousRunData(sprite.snapshots.get(checkpoint.id)!.keys()), [], 'the new baseline holds nothing of the earlier run');
    assert.equal(upgraded.timings.setupMs !== undefined && upgraded.timings.restoreMs !== undefined, true);
    await upgraded.release();
    assert.deepEqual(client.deleted, []);
});

test('a used Sprite without a clean baseline is replaced instead of checkpointed as it is', async () => {
    for (const setupHash of ['feedfacefeedface', undefined]) {
        const client = new FakeSpritesClient();
        const used = await unreleasedRun(client, 'claude-issue-70');
        used.checkpoints.splice(0); // the earlier revision's (or this revision's) checkpoint is gone
        const handle = runtimeFor(client, {}, { setupHash }).start(cloneSpec(claudeStore(), { name: 'claude-issue-72' }), { timeout: 10_000 });
        assert.equal((await handle.wait()).exitCode, 0, `setup hash ${setupHash ?? 'unchanged'}`);
        assert.deepEqual(client.deleted, ['propr-w1-0']);
        assert.deepEqual(client.created, ['propr-w1-0', 'propr-w1-0']);
        const replacement = client.sprites.get('propr-w1-0')!;
        assert.notEqual(replacement, used);
        assert.equal(replacement.checkpoints.length, 1);
        assert.deepEqual(previousRunData(replacement.snapshots.get(replacement.checkpoints[0].id)!.keys()), []);
        assert.deepEqual(used.checkpoints, [], 'nothing was checkpointed on the used Sprite');
        assert.equal(handle.timings.created, true);
        await handle.release();
    }
});

test('setup installs the root-run entrypoints where the agent user cannot replace them, referring only to each other there', { skip: process.platform !== 'linux' }, async () => {
    const { execFileSync } = await import('node:child_process');
    const { SPRITES_ENTRYPOINT_DIR, SPRITES_INSTALLED_ENTRYPOINTS, spritesProtectedEntrypoint } = await import('../packages/core/src/agents/runtime/sprites/spritesCommand.ts');
    const setup = path.resolve('scripts/sprites-agent-setup.sh');
    const target = tempDir('propr-sprites-entrypoints-');
    const entryDir = path.join(target, 'entrypoints');
    const ghBin = path.join(target, 'gh-bin');
    execFileSync('bash', ['-c', 'source "$1"; install_root_entrypoints "$2" "$3" "$4"', 'propr-test', setup, path.resolve('scripts'), entryDir, ghBin]);
    for (const script of SPRITES_INSTALLED_ENTRYPOINTS) {
        const installed = fs.readFileSync(path.join(entryDir, script), 'utf8');
        assert.doesNotMatch(installed, /\/home\/node\/[^\s]*entrypoint|\/home\/node\/bin\b/, `${script} hands root nothing under /home/node`);
        assert.equal(fs.statSync(path.join(entryDir, script)).mode & 0o777, 0o755);
        assert.equal(spritesProtectedEntrypoint(`/home/node/${script}`), `${SPRITES_ENTRYPOINT_DIR}/${script}`);
    }
    // The default entrypoint dispatches to the protected provider entrypoint, and the gh wrapper directory root puts on PATH is protected too.
    assert.ok(fs.readFileSync(path.join(entryDir, 'agent-entrypoint.sh'), 'utf8').includes(`exec "${entryDir}/\${agent_type}-entrypoint.sh"`));
    assert.match(fs.readFileSync(path.join(entryDir, 'claude-entrypoint.sh'), 'utf8'), new RegExp(`export PATH="${ghBin}:\\$PATH"`));
    assert.equal(fs.readlinkSync(path.join(ghBin, 'gh')), '/usr/local/bin/gh-wrapper');
    // Every path root executes must be out of the agent user's reach, ancestors included.
    const user = os.userInfo().username;
    const beyondControl = (file: string) => { try { execFileSync('bash', ['-c', 'source "$1"; beyond_user_control "$2" "$3"', 'propr-test', setup, user, file]); return true; } catch { return false; } };
    assert.equal(beyondControl(path.join(entryDir, 'claude-entrypoint.sh')), false, 'a directory the user owns is refused');
    if (process.getuid!() !== 0) assert.equal(beyondControl('/usr/bin/env'), true, 'root-owned system paths pass');
    const nested = path.join(fs.mkdtempSync(path.join('/tmp', 'propr-sprites-ancestor-')), 'inner');
    fs.mkdirSync(nested);
    assert.equal(beyondControl(nested), false, 'a writable ancestor is refused as well');
});

test('a launcher that cannot return a refreshed credential keeps the live copy and records no export', { skip: !linuxProcesses }, async () => {
    const { execFileSync } = await import('node:child_process');
    const { SPRITES_LAUNCHER_SCRIPT, SPRITES_AGENT_UID_LINE } = await import('../packages/core/src/agents/runtime/sprites/spritesCommand.ts');
    const dir = tempDir('propr-sprites-export-');
    const launcher = path.join(dir, 'launch.sh');
    // As the test user: no root check, no node user, no chown to node; the agent UID is one no process has.
    fs.writeFileSync(launcher, SPRITES_LAUNCHER_SCRIPT.replace(SPRITES_AGENT_UID_LINE, 'agent_uid=2147483000').replace('[ "$(id -u)" = "0" ]', 'true')
        .replace('id node >/dev/null 2>&1', 'true').replaceAll('chown -R node:node --', 'true --').replaceAll('chown node:node --', 'true --'));
    const nul = (values: string[]) => values.map(value => `${value}\0`).join('');
    const runDir = (name: string) => {
        const run = path.join(dir, name);
        const live = path.join(dir, `${name}-home`, '.claude');
        fs.mkdirSync(path.join(run, 'store', 'claude'), { recursive: true });
        fs.writeFileSync(path.join(run, 'store', 'claude', '.credentials.json'), '{"token":"old"}');
        fs.writeFileSync(path.join(run, 'argv'), nul(['bash', '-c', 'printf \'{"token":"rotated"}\' > "$1/.credentials.json"', 'agent', live]));
        fs.writeFileSync(path.join(run, 'env'), nul([`PATH=${process.env.PATH}`]));
        fs.writeFileSync(path.join(run, 'manifest'), nul(['store', 'store/claude', live, 'output', dir, path.relative(dir, path.join(live, '.credentials.json')), 'returned/claude/.credentials.json']));
        fs.writeFileSync(path.join(run, 'workdir'), path.join(dir, `${name}-work`));
        fs.writeFileSync(path.join(run, 'user'), 'root');
        return { run, live };
    };
    const failed = runDir('failed');
    fs.writeFileSync(path.join(failed.run, 'returned'), 'not a directory'); // the copy into returned/ fails
    execFileSync('bash', [launcher, failed.run]);
    assert.equal(fs.readFileSync(path.join(failed.run, 'exit-status'), 'utf8'), '0\n', 'the exit status alone does not confirm the export');
    assert.equal(fs.existsSync(path.join(failed.run, 'credentials-exported')), false);
    assert.equal(fs.readFileSync(path.join(failed.live, '.credentials.json'), 'utf8'), '{"token":"rotated"}', 'the only rotated copy survives');
    assert.match(fs.readFileSync(path.join(failed.run, 'stderr.log'), 'utf8'), /cannot return the refreshed credential/);

    const exported = runDir('exported');
    execFileSync('bash', [launcher, exported.run]);
    assert.equal(fs.readFileSync(path.join(exported.run, 'credentials-exported'), 'utf8'), 'ok\n');
    assert.equal(fs.readFileSync(path.join(exported.run, 'returned', 'claude', '.credentials.json'), 'utf8'), '{"token":"rotated"}');
    assert.equal(fs.existsSync(exported.live), false, 'a confirmed export removes the live copy');
});

test('the launcher never exports a credential through a symlink the agent planted on its path, and keeps the recovery obligation', { skip: !linuxProcesses }, async () => {
    const { execFileSync } = await import('node:child_process');
    const { SPRITES_LAUNCHER_SCRIPT, SPRITES_AGENT_UID_LINE } = await import('../packages/core/src/agents/runtime/sprites/spritesCommand.ts');
    const dir = tempDir('propr-sprites-symlink-');
    const resultDir = path.join(dir, 'workspace-result');
    const launcher = path.join(dir, 'launch.sh');
    // As the test user (see above), with the result directory moved into the sandbox.
    const script = SPRITES_LAUNCHER_SCRIPT.replace(SPRITES_AGENT_UID_LINE, 'agent_uid=2147483000').replace('[ "$(id -u)" = "0" ]', 'true')
        .replace('id node >/dev/null 2>&1', 'true').replaceAll('chown -R node:node --', 'true --').replaceAll('chown node:node --', 'true --')
        .replaceAll(WORKSPACE_TRANSPORT_RESULT_DIR, resultDir);
    fs.writeFileSync(launcher, script);
    // The Sprite user's own credentials, which no run may receive.
    const privateHome = path.join(dir, 'sprite');
    fs.mkdirSync(path.join(privateHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(privateHome, '.codex', 'auth.json'), '{"token":"sprite-account"}');
    const nul = (values: string[]) => values.map(value => `${value}\0`).join('');
    const runDir = (name: string, agent: string, launcherScript = launcher) => {
        const run = path.join(dir, name);
        const home = path.join(dir, `${name}-home`);
        const live = path.join(home, '.codex');
        fs.mkdirSync(path.join(run, 'store', 'codex'), { recursive: true });
        fs.writeFileSync(path.join(run, 'store', 'codex', 'auth.json'), '{"token":"run-copy"}');
        fs.writeFileSync(path.join(run, 'argv'), nul(['bash', '-c', agent, 'agent', home, privateHome, resultDir]));
        fs.writeFileSync(path.join(run, 'env'), nul([`PATH=${process.env.PATH}`]));
        // The boundary is the directory the agent cannot replace (on a Sprite, /home/node); here the sandbox.
        fs.writeFileSync(path.join(run, 'manifest'), nul(['store', 'store/codex', live, 'output', dir, path.relative(dir, path.join(live, 'auth.json')), 'returned/codex/auth.json']));
        fs.writeFileSync(path.join(run, 'workdir'), path.join(dir, `${name}-work`));
        fs.writeFileSync(path.join(run, 'user'), 'root');
        execFileSync('bash', [launcherScript, run]);
        return { run, live };
    };
    const refused = (run: string, why: string) => {
        assert.equal(fs.existsSync(path.join(run, 'returned', 'codex', 'auth.json')), false, `${why}: nothing is returned`);
        assert.equal(fs.existsSync(path.join(run, 'credentials-exported')), false, `${why}: no export is recorded, so the recovery obligation stays`);
        assert.match(fs.readFileSync(path.join(run, 'stderr.log'), 'utf8'), /a symlink or non-regular file is on its path/);
    };

    // The store directory itself replaced by a link to the Sprite user's store.
    const store = runDir('store-link', 'rm -rf "$1/.codex" && ln -s "$2/.codex" "$1/.codex"');
    refused(store.run, 'a symlinked store directory');
    assert.equal(fs.readlinkSync(store.live), path.join(privateHome, '.codex'), 'the live copies are kept as they are for recovery');
    // An ancestor above the store replaced: the run's home now leads to the Sprite user's home.
    const ancestor = runDir('ancestor-link', 'mv "$1" "$1.moved" && ln -s "$2" "$1"');
    refused(ancestor.run, 'a symlinked ancestor');
    // The token file itself.
    refused(runDir('file-link', 'rm -f "$1/.codex/auth.json" && ln -s "$2/.codex/auth.json" "$1/.codex/auth.json"').run, 'a symlinked token');
    assert.equal(fs.readFileSync(path.join(privateHome, '.codex', 'auth.json'), 'utf8'), '{"token":"sprite-account"}', 'the Sprite user\'s credentials are untouched');

    // A deleted token is no refresh (never propagated); an untouched one is returned as usual.
    const deleted = runDir('deleted', 'rm -rf "$1/.codex"');
    assert.equal(fs.readFileSync(path.join(deleted.run, 'credentials-exported'), 'utf8'), 'ok\n');
    const plain = runDir('plain', 'printf \'{"token":"rotated"}\' > "$1/.codex/auth.json"');
    assert.equal(fs.readFileSync(path.join(plain.run, 'returned', 'codex', 'auth.json'), 'utf8'), '{"token":"rotated"}');
    assert.equal(fs.readFileSync(path.join(plain.run, 'credentials-exported'), 'utf8'), 'ok\n');

    // A run process that survived SIGKILL could swap a checked path: nothing is returned.
    const survivorLauncher = path.join(dir, 'launch-survivor.sh');
    fs.writeFileSync(survivorLauncher, script.replace('if ! kill_run_members "$run_dir" "$child"; then', 'if ! false; then'));
    const survived = runDir('survivor', 'printf \'{"token":"rotated"}\' > "$1/.codex/auth.json"', survivorLauncher);
    assert.equal(fs.existsSync(path.join(survived.run, 'returned', 'codex', 'auth.json')), false);
    assert.equal(fs.existsSync(path.join(survived.run, 'credentials-exported')), false);
    assert.equal(fs.readFileSync(path.join(survived.live, 'auth.json'), 'utf8'), '{"token":"rotated"}', 'the only rotated copy survives');

    // The workspace result: a symlinked result directory is not followed, nor are symlinks inside a real one kept.
    const linkedResult = runDir('result-link', 'ln -s "$2/.codex" "$3"');
    assert.equal(fs.existsSync(path.join(linkedResult.run, 'result')), false);
    const innerLink = runDir('result-inner-link', 'mkdir -p "$3" && printf done > "$3/status" && ln -s "$2/.codex/auth.json" "$3/result.bundle"');
    assert.equal(fs.readFileSync(path.join(innerLink.run, 'result', 'status'), 'utf8'), 'done');
    assert.equal(fs.existsSync(path.join(innerLink.run, 'result', 'result.bundle')), false);
    assert.equal(fs.lstatSync(path.join(innerLink.run, 'result', 'status')).isFile(), true);
});

test('credential output records name the boundary the agent cannot replace and reject paths that leave the store', async () => {
    const { spritesOutputRecord } = await import('../packages/core/src/agents/runtime/sprites/spritesCommand.ts');
    assert.deepEqual(spritesOutputRecord('/home/node/.codex', 'auth.json', 'returned/codex/auth.json'), ['output', '/home/node', '.codex/auth.json', 'returned/codex/auth.json']);
    assert.deepEqual(spritesOutputRecord('/home/node/.config/opencode', 'auth/token.json', 'returned/o/auth/token.json'), ['output', '/home/node', '.config/opencode/auth/token.json', 'returned/o/auth/token.json']);
    assert.deepEqual(spritesOutputRecord('/run/propr-claude', '.credentials.json', 'returned/c/.credentials.json'), ['output', '/run', 'propr-claude/.credentials.json', 'returned/c/.credentials.json']);
    assert.deepEqual(spritesOutputRecord('/tmp/propr-x', 'token', 'returned/x/token'), ['output', '/tmp', 'propr-x/token', 'returned/x/token']);
    for (const [target, output] of [['/home/node/.codex', '../.claude/x'], ['/home/node/.codex', ''], ['/etc', 'shadow'], ['/home/node/workspace', 'x']]) {
        assert.throws(() => spritesOutputRecord(target, output, 'returned/x'), /cannot return a credential/);
    }
});

test('a failed credential export keeps the rotated token and the recovery obligation instead of trusting the exit status', async () => {
    const client = new FakeSpritesClient();
    const credentials = claudeStore();
    client.configureSprite = sprite => {
        sprite.exportFails = true;
        sprite.agent = async context => { context.files.set('/home/node/.claude/.credentials.json', Buffer.from('{"token":"rotated"}')); return 0; };
    };
    const runtime = runtimeFor(client, { PROPR_SPRITES_MAX_SPRITES: '1' });
    const handle = runtime.start(cloneSpec(credentials, { name: 'claude-issue-80' }), { timeout: 10_000 });
    assert.equal((await handle.wait()).exitCode, 0);
    await handle.release();
    const sprite = client.sprites.get('propr-w1-0')!;
    const root = `/tmp/propr-sprite-runs/${spritesRunId({ name: 'claude-issue-80' })}`;
    assert.equal(sprite.files.get(`${root}/exit-status`)?.toString(), '0\n');
    assert.equal(fs.readFileSync(path.join(credentials, '.credentials.json'), 'utf8'), '{"token":"old"}', 'no unconfirmed export counts as "nothing refreshed"');
    assert.equal(sprite.files.get('/home/node/.claude/.credentials.json')?.toString(), '{"token":"rotated"}', 'the live copy is kept for recovery');
    const obligation = JSON.parse(sprite.files.get(`${root}/credentials-retained`)!.toString());
    assert.equal(obligation.reason, 'export-failed');
    assert.deepEqual(obligation.liveCopies, ['/home/node/.claude']);
    assert.deepEqual(sprite.restored, [], 'the Sprite is not restored over the live copy');
    await assert.rejects(runtime.start(cloneSpec(claudeStore(), { name: 'claude-issue-81' }), { timeout: 10_000 }).wait(), /awaiting recovery/);
});

test('a run whose stop requests fail settles as interrupted within the stop bound and keeps its Sprite out of use', async () => {
    for (const via of ['timeout', 'stop'] as const) {
        const client = new FakeSpritesClient();
        const credentials = claudeStore();
        let finish!: (status: number) => void;
        client.configureSprite = sprite => {
            sprite.signalFails = true;
            sprite.agent = async context => {
                context.files.set('/home/node/.claude/.credentials.json', Buffer.from('{"token":"rotated"}'));
                return new Promise<number>(resolve => { finish = resolve; });
            };
        };
        const runtime = runtimeFor(client, { PROPR_SPRITES_MAX_SPRITES: '1' }, { stopSettlementMs: 200 });
        const name = `claude-issue-9${via === 'timeout' ? 0 : 1}`;
        const started = Date.now();
        const handle = runtime.start(cloneSpec(credentials, { name }), { timeout: via === 'timeout' ? 150 : 60_000 });
        const waited = handle.wait().then(() => null, error => error as Error);
        if (via === 'stop') {
            await sleep(50);
            await handle.stop();
        }
        const error = await waited;
        if (via === 'timeout') assert.ok(error instanceof SpritesRunInterruptedError && /did not confirm that it stopped within 200ms of its timeout stop request/.test(error.message), String(error));
        else assert.equal(error?.name, 'AgentRunStoppedError');
        assert.ok(Date.now() - started < 5_000, `${via}: settled within its bound`);
        await handle.release(); // resolves: cleanup ran, even though nothing confirmed the run stopped
        const sprite = client.sprites.get('propr-w1-0')!;
        assert.ok(sprite.signals.includes('TERM') && sprite.signals.includes('KILL'));
        assert.deepEqual(sprite.restored, [], `${via}: a Sprite whose run may still be running is not cleaned for reuse`);
        const root = `/tmp/propr-sprite-runs/${spritesRunId({ name })}`;
        assert.equal(JSON.parse(sprite.files.get(`${root}/credentials-retained`)!.toString()).reason, 'export-unconfirmed');
        assert.equal(sprite.files.get('/home/node/.claude/.credentials.json')?.toString(), '{"token":"rotated"}');
        const keepAlive = setInterval(() => undefined, 50);
        await assert.rejects(runtime.start(cloneSpec(claudeStore(), { name: `${name}b` }), { timeout: 200 }).wait(), /timed out after 200ms/, 'its slot stays taken');
        clearInterval(keepAlive);
        finish(143);
    }
});

test('a CLI version other than the Sprite\'s pin is refused at launch and when the configuration is saved', async () => {
    const { spritesCliVersionRefusal, spritesAgentConfigRefusal } = await import('../packages/core/src/agents/runtime/sprites/spritesCliVersions.ts');
    const { runAgent, AgentRuntimeCapabilityError } = await import('../packages/core/src/agents/runtime/registry.ts');
    const pins = readSpritesCliPins(process.cwd());
    const { AGENT_DEFAULT_VERSIONS } = await import('../packages/core/src/agents/version/types.ts');
    assert.equal(AGENT_DEFAULT_VERSIONS.claude, pins.CLAUDE_CLI_VERSION, 'the default version is the one a Sprite runs');
    assert.equal(AGENT_DEFAULT_VERSIONS.codex, pins.CODEX_CLI_VERSION);
    assert.equal(AGENT_DEFAULT_VERSIONS.antigravity, pins.ANTIGRAVITY_CLI_VERSION);
    assert.equal(spritesCliVersionRefusal({ type: 'claude' }, pins), undefined);
    assert.equal(spritesCliVersionRefusal({ type: 'codex', cliVersionType: 'default', cliVersionResolved: pins.CODEX_CLI_VERSION }, pins), undefined);
    assert.equal(spritesCliVersionRefusal({ type: 'claude', cliVersionType: 'specific', cliVersion: pins.CLAUDE_CLI_VERSION }, pins), undefined, 'selecting the pinned version explicitly is fine');
    assert.match(spritesCliVersionRefusal({ type: 'claude', alias: 'old-claude', cliVersionType: 'specific', cliVersion: '2.0.1', cliVersionResolved: '2.0.1' }, pins)!,
        new RegExp(`Agent 'old-claude' selects claude CLI 2\\.0\\.1, but the Sprites runtime runs only claude CLI ${pins.CLAUDE_CLI_VERSION.replaceAll('.', '\\.')}`));
    assert.match(spritesCliVersionRefusal({ type: 'codex', cliVersionType: 'tag', cliVersion: 'latest' }, pins)!, /selects codex CLI tag latest/, 'an unresolved tag is not assumed to be the pin');
    assert.match(spritesCliVersionRefusal({ type: 'antigravity', cliVersionResolved: '1.0.0' }, pins)!, /antigravity CLI 1\.0\.0/);
    // Saving: only enabled agents that select Sprites (themselves or through PROPR_AGENT_RUNTIME).
    const old = { type: 'claude' as const, alias: 'old-claude', enabled: true, cliVersionType: 'specific' as const, cliVersion: '2.0.1', cliVersionResolved: '2.0.1' };
    assert.equal(spritesAgentConfigRefusal([old], {}, pins), undefined, 'Docker runs any version');
    assert.match(spritesAgentConfigRefusal([{ ...old, runtime: 'sprites' }], {}, pins)!, /old-claude/);
    assert.match(spritesAgentConfigRefusal([old], { PROPR_AGENT_RUNTIME: 'sprites' }, pins)!, /old-claude/);
    assert.equal(spritesAgentConfigRefusal([{ ...old, enabled: false, runtime: 'sprites' }], {}, pins), undefined);
    // Launching: refused before anything reaches a Sprite.
    const spec = cloneSpec(claudeStore(), { name: 'claude-issue-95' });
    await assert.rejects(runAgent({ ...old, runtime: 'sprites' }, spec, { timeout: 1_000 }),
        (error: Error) => error instanceof AgentRuntimeCapabilityError && error.capability === 'agent_config' && /selects claude CLI 2\.0\.1/.test(error.message));
    const runtime = runtimeFor(new FakeSpritesClient());
    assert.equal(runtime.unsupportedAgentConfig(null, spec), undefined, 'the default agent runs the pinned version');
    assert.match(runtime.unsupportedAgentConfig({ runtime: 'sprites', type: 'claude', cliVersionResolved: '2.0.1' }, spec)!, /2\.0\.1/);
});

test('setup runs its scripts as root from the run root, where the agent user cannot create or replace entries', async () => {
    const { SPRITES_SETUP_UPLOAD_DIR } = await import('../packages/core/src/agents/runtime/sprites/spritesProvisioning.ts');
    assert.equal(SPRITES_SETUP_UPLOAD_DIR, '/tmp/propr-sprite-runs/.setup');
    const client = new FakeSpritesClient();
    const handle = runtimeFor(client).start(cloneSpec(claudeStore(), { name: 'claude-issue-96' }), { timeout: 10_000 });
    assert.equal((await handle.wait()).exitCode, 0);
    const setup = client.sprites.get('propr-w1-0')!.calls.find(call => call.file === 'sudo' && call.args.includes('env'))!;
    assert.deepEqual(setup.args.slice(-3), ['bash', `${SPRITES_SETUP_UPLOAD_DIR}/sprites-agent-setup.sh`, SPRITES_SETUP_UPLOAD_DIR]);
    await handle.release();
});
