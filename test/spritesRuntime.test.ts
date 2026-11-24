import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { FAKE_RUN_DIR, type FakeSprite } from './helpers/fakeSprites.ts';
import { cloneSpec, createCredentialStore, createHarness, liveTokenPath, ORG_TOKEN, TEST_BUNDLE } from './helpers/spritesHarness.ts';

const { AgentRunStoppedError } = await import('../packages/core/src/agents/runtime/agentRunOutput.ts');
const { SpritesRunInterruptedError } = await import('../packages/core/src/agents/runtime/spritesRuntime.ts');
const { SPRITES_CLIENT_SIGNALS_ENV } = await import('../packages/core/src/agents/runtime/sprites/spritesConfig.ts');
const { default: logger } = await import('../packages/core/src/utils/logger.ts');

const SPRITE = 'propr-w1-0';
const CLEAN_PATHS = ['/', '/home', '/home/node', '/home/node/workspace', '/opt', '/opt/propr', '/opt/propr/bin', '/opt/propr/entrypoints', '/opt/propr/launcher.sh', '/opt/propr/run', '/opt/propr/sprites-setup.hash', '/tmp'];

/** What a run leaves behind: the #3786 findings were each of these reaching the next run. */
function leaveEverything(agent: 'claude' | 'antigravity' = 'claude') {
    return (context: { write(file: string, content: string): void }) => {
        context.write('/home/node/workspace/src/secret.txt', 'workspace of run 1');
        context.write('/home/node/workspace/.git/config', 'origin');
        context.write('/tmp/claude-logs/session.jsonl', 'log of run 1');
        context.write('/home/node/.cache-scratch/notes', 'scratch of run 1');
        context.write('/tmp/leftover-by-agent', 'tmp of run 1');
        context.write('/home/node/.bashrc', 'planted for the next run');
        context.write(liveTokenPath(agent), `${agent}-token-refreshed`);
    };
}

test('the first run provisions and checkpoints its Sprite; every later run starts on the restored checkpoint', async () => {
    const harness = createHarness();
    const store = createCredentialStore(harness.root, 'claude');
    harness.client.behaviors.push(
        { stdout: 'run one\n', act: leaveEverything(), resultStatus: 'bundle abc', resultBundle: Buffer.from('BUNDLE') },
        { stdout: 'run two\n' },
    );
    const first = harness.runtime.start(cloneSpec('run-1', { credentialStore: store.directory }), { timeout: 5000, stdinData: 'prompt one' });
    assert.equal((await first.wait()).stdout, 'run one\n');
    await first.release();
    const sprite = harness.client.sprites.get(SPRITE)!;
    assert.deepEqual(harness.client.operations, [`create:${SPRITE}`, `setup:${SPRITE}`, `checkpoint:v1:${SPRITE}`, `run:run-1:${SPRITE}`, `restore:v1:${SPRITE}`]);
    // Provisioning installed exactly the CLIs Dockerfile.agent pins, Antigravity's verified archive included.
    assert.deepEqual(sprite.setupEnvironment, { ...TEST_BUNDLE.pins, PROPR_SPRITES_SETUP_HASH: TEST_BUNDLE.hash });
    assert.deepEqual(sprite.runs[0].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
    assert.equal(sprite.runs[0].stdin, 'prompt one');
    // Nothing of run 1 is on the Sprite once it was released.
    assert.deepEqual(sprite.paths(), CLEAN_PATHS);

    const second = harness.runtime.start(cloneSpec('run-2', { credentialStore: store.directory }), { timeout: 5000, stdinData: 'prompt two' });
    assert.equal((await second.wait()).stdout, 'run two\n');
    await second.release();
    // Run 2 saw the clean checkpoint and its own payload: no workspace, result bundle, logs, scratch, HOME files or tokens of run 1.
    assert.deepEqual(sprite.runs[1].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
    assert.deepEqual(harness.client.operations.slice(5), [`run:run-2:${SPRITE}`, `restore:v1:${SPRITE}`]);
    assert.equal(typeof second.timings.credentialSyncMs, 'number');
    assert.equal(second.timings.provisionMs, undefined, 'a warm run neither provisions');
    assert.equal(second.timings.restoreMs, undefined, 'nor restores before it starts: the restore ran when run 1 ended');
    assert.equal(second.timings.recycleAction, 'restored');
});

test('Antigravity: the disposable HOME and its oauth token do not survive the run', async () => {
    const harness = createHarness();
    const store = createCredentialStore(harness.root, 'antigravity');
    harness.client.behaviors.push({ act: leaveEverything('antigravity') }, {});
    const first = harness.runtime.start(cloneSpec('agy-1', { agent: 'antigravity', credentialStore: store.directory }), { timeout: 5000 });
    await first.wait();
    await first.release();
    const sprite = harness.client.sprites.get(SPRITE)!;
    // The source the entrypoint copies from is installed read-only for the agent user, and the token returns from the live copy.
    assert.deepEqual(sprite.runs[0].records.filter(record => record[0] === 'source'), [['source', 'store/0', '/home/node/.gemini-source']]);
    assert.deepEqual(sprite.runs[0].outputs, [{ index: 0, livePath: liveTokenPath('antigravity') }]);
    assert.equal(fs.readFileSync(store.tokenFile, 'utf8'), 'antigravity-token-refreshed', 'the refreshed token reached the canonical store through the export');
    assert.ok(!sprite.paths().some(file => file.includes('antigravity') || file.includes('.gemini')), 'no Antigravity HOME or token is left');
    const second = harness.runtime.start(cloneSpec('agy-2', { agent: 'antigravity', credentialStore: store.directory }), { timeout: 5000 });
    await second.wait();
    await second.release();
    assert.ok(!sprite.runs[1].pathsAtLaunch.some(file => file.startsWith('/tmp/propr-antigravity-home') || file.startsWith('/home/node/.gemini')));
});

test('the Sprite is restored after a failed run and after a killed run', async () => {
    const harness = createHarness();
    harness.client.behaviors.push({ exitCode: 3, stderr: 'boom\n', act: leaveEverything() }, { hang: true, act: leaveEverything() }, {});
    const failed = harness.runtime.start(cloneSpec('failed'), { timeout: 5000 });
    const failure = await failed.wait();
    assert.equal(failure.exitCode, 3);
    assert.match(failure.stderr, /boom/);
    await failed.release();
    const sprite = harness.client.sprites.get(SPRITE)!;
    assert.deepEqual(sprite.paths(), CLEAN_PATHS);

    const killed = harness.runtime.start(cloneSpec('killed'), { timeout: 5000 });
    const outcome = killed.wait().then(() => 'resolved', error => error);
    while (sprite.runs.length < 2) await new Promise(resolve => setImmediate(resolve));
    await killed.stop();
    assert.ok(await outcome instanceof AgentRunStoppedError);
    await killed.release();
    assert.deepEqual(sprite.paths(), CLEAN_PATHS);
    assert.deepEqual(harness.client.operations.filter(operation => operation.startsWith('restore')), [`restore:v1:${SPRITE}`, `restore:v1:${SPRITE}`]);

    const next = harness.runtime.start(cloneSpec('after'), { timeout: 5000 });
    await next.wait();
    await next.release();
    assert.deepEqual(sprite.runs[2].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
});

test('the restore does not wait for release(): a run nobody releases still frees a clean Sprite', async () => {
    const harness = createHarness();
    harness.client.behaviors.push({ act: leaveEverything(), resultStatus: 'bundle abc', resultBundle: Buffer.from('BUNDLE') }, {});
    const first = harness.runtime.start(cloneSpec('unreleased'), { timeout: 5000 });
    await first.wait();
    first.retain();
    // The result was read off the Sprite before the restore and stays readable on the worker.
    assert.equal((await first.readFile('/tmp/propr-workspace-result/status'))?.toString(), 'bundle abc\n');
    assert.equal((await first.readFile('/tmp/propr-workspace-result/result.bundle'))?.toString(), 'BUNDLE');
    const second = harness.runtime.start(cloneSpec('next'), { timeout: 5000 });
    await second.wait();
    const sprite = harness.client.sprites.get(SPRITE)!;
    assert.deepEqual(sprite.runs[1].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
    assert.equal((await first.readFile('/tmp/propr-workspace-result/result.bundle'))?.toString(), 'BUNDLE', 'retained until released');
    await first.release();
    assert.equal(await first.readFile('/tmp/propr-workspace-result/result.bundle'), null);
    await second.release();
});

test('a failed restore destroys the Sprite and provisions a new one', async () => {
    const harness = createHarness();
    // The restore starts as soon as the run ends, so its failure is arranged while the run is going.
    harness.client.behaviors.push({ act: context => { leaveEverything()(context); context.sprite.failRestores = 1; } }, {});
    const first = harness.runtime.start(cloneSpec('run-1'), { timeout: 5000 });
    await first.wait();
    const original = harness.client.sprites.get(SPRITE)!;
    await first.release();
    assert.equal(first.timings.recycleAction, 'replaced');
    assert.deepEqual(harness.client.operations.slice(3), [
        `run:run-1:${SPRITE}`, `restore-failed:v1:${SPRITE}`, `delete:${SPRITE}`, `create:${SPRITE}`, `setup:${SPRITE}`, `checkpoint:v1:${SPRITE}`,
    ]);
    const replacement = harness.client.sprites.get(SPRITE)!;
    assert.notEqual(replacement.id, original.id);
    const second = harness.runtime.start(cloneSpec('run-2'), { timeout: 5000 });
    await second.wait();
    await second.release();
    assert.equal(original.runs.length, 1, 'the unrestorable Sprite never ran again');
    assert.deepEqual(replacement.runs[0].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
});

test('a Sprite that can be neither restored nor replaced is replaced before its next run, never run on', async () => {
    const harness = createHarness();
    harness.client.behaviors.push({ act: context => { leaveEverything()(context); context.sprite.failRestores = 1; harness.client.failSetups = 1; } }, {});
    const first = harness.runtime.start(cloneSpec('run-1'), { timeout: 5000 });
    await first.wait();
    await first.release();
    assert.equal(first.timings.recycleAction, 'failed');
    const second = harness.runtime.start(cloneSpec('run-2'), { timeout: 5000 });
    await second.wait();
    await second.release();
    const sprite = harness.client.sprites.get(SPRITE)!;
    assert.equal(sprite.runs.length, 1);
    assert.deepEqual(sprite.runs[0].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
    assert.equal(typeof second.timings.provisionMs, 'number');
});

test('a run whose processes cannot be confirmed dead gets its Sprite destroyed, not restored', async () => {
    const harness = createHarness();
    harness.client.behaviors.push({ hang: true, act: leaveEverything() }, {});
    const handle = harness.runtime.start(cloneSpec('stuck'), { timeout: 5000 });
    const outcome = handle.wait().then(() => 'resolved', error => error);
    while (!harness.client.sprites.get(SPRITE)?.runs.length) await new Promise(resolve => setImmediate(resolve));
    const original = harness.client.sprites.get(SPRITE)!;
    original.killFails = true;
    // TERM ends the fake run, but its status never says the launcher exited cleanly and KILL reports survivors.
    const execFile = original.execFile.bind(original);
    original.execFile = async (command, args = []) => args.includes('status') ? { stdout: 'running=1\nexit=\nexport=\n', stderr: '', exitCode: 0 } : execFile(command, args);
    await handle.stop();
    assert.ok(await outcome instanceof Error);
    await handle.release();
    assert.equal(handle.timings.recycleAction, 'replaced');
    assert.ok(harness.client.operations.includes(`delete:${SPRITE}`));
    assert.ok(!harness.client.operations.some(operation => operation.startsWith('restore:')), 'no restore was trusted on a Sprite with live processes');
    assert.notEqual(harness.client.sprites.get(SPRITE)!.id, original.id);
});

test('a restarted worker restores the Sprite before its first run instead of trusting what it finds', async () => {
    const harness = createHarness();
    harness.client.behaviors.push({ act: leaveEverything() }, {}, {});
    const first = harness.runtime.start(cloneSpec('run-1'), { timeout: 5000 });
    await first.wait();
    await first.release();
    const sprite = harness.client.sprites.get(SPRITE)!;
    // The previous worker died mid-run: files of that run are on the Sprite, and the agent forged a "clean" checkpoint.
    sprite.putFile('/home/node/workspace/abandoned.txt', 'left by a crashed worker');
    await sprite.createCheckpoint(`propr-clean ${TEST_BUNDLE.hash}`);
    const restarted = harness.restart();
    const second = restarted.start(cloneSpec('run-2'), { timeout: 5000 });
    await second.wait();
    await second.release();
    assert.deepEqual(sprite.runs[1].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
    assert.equal(typeof second.timings.restoreMs, 'number');
    // Only the checkpoint the worker recorded when it provisioned the Sprite is ever restored, not the newer one with the same comment.
    assert.ok(harness.client.operations.filter(operation => operation.startsWith('restore')).every(operation => operation === `restore:v1:${SPRITE}`));

    // Without its record (another host, a wiped state directory) the worker does not guess: the Sprite is replaced.
    fs.rmSync(path.join(harness.stateDir, `${SPRITE}.json`));
    const third = harness.restart().start(cloneSpec('run-3'), { timeout: 5000 });
    await third.wait();
    await third.release();
    assert.notEqual(harness.client.sprites.get(SPRITE)!.id, sprite.id);
    assert.equal(sprite.runs.length, 2);
});

test('a Sprite provisioned for another setup revision is replaced', async () => {
    const harness = createHarness();
    const first = harness.runtime.start(cloneSpec('run-1'), { timeout: 5000 });
    await first.wait();
    await first.release();
    const original = harness.client.sprites.get(SPRITE)!;
    const upgraded = createHarness({ root: harness.root, client: harness.client, bundle: { ...TEST_BUNDLE, hash: 'setuphash0000002' } });
    const second = upgraded.runtime.start(cloneSpec('run-2'), { timeout: 5000 });
    await second.wait();
    await second.release();
    const replacement = harness.client.sprites.get(SPRITE)!;
    assert.notEqual(replacement.id, original.id);
    assert.equal(replacement.setupEnvironment.PROPR_SPRITES_SETUP_HASH, 'setuphash0000002');
});

test('one run per Sprite: a second run waits until the first run ended and its Sprite was restored', async () => {
    const harness = createHarness({ maxSprites: 1 });
    harness.client.behaviors.push({ hang: true, act: leaveEverything() }, {});
    const first = harness.runtime.start(cloneSpec('run-1'), { timeout: 5000 });
    const firstOutcome = first.wait().catch(error => error);
    while (!harness.client.sprites.get(SPRITE)?.runs.length) await new Promise(resolve => setImmediate(resolve));
    const second = harness.runtime.start(cloneSpec('run-2'), { timeout: 5000 });
    for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
    const sprite = harness.client.sprites.get(SPRITE)!;
    assert.equal(sprite.runs.length, 1, 'the second run has not reached the Sprite');
    await first.stop();
    await firstOutcome;
    await second.wait();
    const order = harness.client.operations.filter(operation => /^(run|restore)/.test(operation));
    assert.deepEqual(order.slice(0, 3), [`run:run-1:${SPRITE}`, `restore:v1:${SPRITE}`, `run:run-2:${SPRITE}`]);
    assert.deepEqual(sprite.runs[1].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
    assert.equal(typeof second.timings.queueMs, 'number');
    await Promise.all([first.release(), second.release()]);
});

test('with several Sprites, concurrent runs each get their own', async () => {
    const harness = createHarness({ maxSprites: 2 });
    harness.client.behaviors.push({ hang: true }, { hang: true });
    const handles = [harness.runtime.start(cloneSpec('a'), { timeout: 5000 }), harness.runtime.start(cloneSpec('b'), { timeout: 5000 })];
    const outcomes = handles.map(handle => handle.wait().catch(error => error));
    while ([...harness.client.sprites.values()].reduce((count, sprite) => count + sprite.runs.length, 0) < 2) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...harness.client.sprites.keys()].sort(), ['propr-w1-0', 'propr-w1-1']);
    assert.deepEqual([...harness.client.sprites.values()].map(sprite => sprite.runs.length), [1, 1]);
    await Promise.all(handles.map(handle => handle.stop()));
    await Promise.all(outcomes);
    await Promise.all(handles.map(handle => handle.release()));
});

test('a Sprite locked by another live worker process is not used', async () => {
    const harness = createHarness({ maxSprites: 1 });
    fs.mkdirSync(harness.stateDir, { recursive: true });
    const lock = path.join(harness.stateDir, `${SPRITE}.lock`);
    fs.writeFileSync(lock, `${process.ppid}\n`);
    const handle = harness.runtime.start(cloneSpec('waiting'), { timeout: 5000 });
    for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.client.operations.length, 0, 'the Sprite of the other process is left alone');
    // A lock whose owner is gone is taken over.
    fs.writeFileSync(lock, '2147483646\n');
    await handle.wait();
    await handle.release();
    assert.ok(!fs.existsSync(lock));
});

test('refreshed credentials return only through the export; the reader refuses symlinks, special files and oversize files', async () => {
    const harness = createHarness();
    const store = createCredentialStore(harness.root, 'claude');
    const live = liveTokenPath('claude');
    const run = async (name: string, behavior: Parameters<typeof harness.client.behaviors.push>[0]) => {
        harness.client.behaviors.push(behavior);
        const handle = harness.runtime.start(cloneSpec(name, { credentialStore: store.directory }), { timeout: 5000 });
        await handle.wait();
        await handle.release();
        return fs.readFileSync(store.tokenFile, 'utf8');
    };
    // The run received its per-run copy, and a refreshed token is written back.
    assert.equal(await run('refresh', {
        act: context => {
            assert.equal(context.sprite.files.get(live)?.type, 'file');
            context.write(live, 'claude-token-v2');
        },
    }), 'claude-token-v2');
    const sprite = harness.client.sprites.get(SPRITE)!;
    assert.deepEqual(sprite.runs[0].records.filter(record => record[0] === 'store'), [['store', 'store/0', '/home/node/.claude']]);

    // A symlink the agent planted at the live path is never exported (the launcher reads as the agent user and takes plain files only).
    assert.equal(await run('planted-link', {
        act: context => {
            context.write('/root/secret', 'root-only');
            context.sprite.put(live, { type: 'symlink', target: '/root/secret' });
        },
    }), 'claude-token-v2');

    // Even if the export directory itself held something else, the worker's reader refuses it.
    const tamper = (plant: (target: FakeSprite, file: string) => void) => (context: { sprite: FakeSprite }) => plant(context.sprite, `${FAKE_RUN_DIR}/out/0`);
    assert.equal(await run('export-symlink', {
        act: context => context.write(live, 'claude-token-v3'),
        tamper: tamper((target, file) => { target.putFile('/root/secret', 'root-only secret'); target.put(file, { type: 'symlink', target: '/root/secret' }); }),
    }), 'claude-token-v2', 'a symlink in the export is not followed');
    assert.equal(await run('export-fifo', {
        act: context => context.write(live, 'claude-token-v3'),
        tamper: tamper((target, file) => target.put(file, { type: 'fifo' })),
    }), 'claude-token-v2', 'a special file in the export is refused');
    assert.equal(await run('export-directory', {
        act: context => context.write(live, 'claude-token-v3'),
        tamper: tamper((target, file) => target.put(file, { type: 'dir' })),
    }), 'claude-token-v2', 'a directory in the export is refused');
    assert.equal(await run('export-oversize', {
        act: context => context.write(live, 'claude-token-v3'),
        tamper: tamper((target, file) => target.putFile(file, Buffer.alloc(1024 * 1024 + 1, 0x61))),
    }), 'claude-token-v2', 'an oversize export is refused');

    // No export when agent processes survived: nothing is read, nothing is written back.
    assert.equal(await run('unsafe', { act: context => context.write(live, 'claude-token-v4'), exportState: 'unsafe' }), 'claude-token-v2');
    // A deleted token is never propagated.
    assert.equal(await run('deleted', { act: context => context.sprite.remove(live) }), 'claude-token-v2');
});

test('the workspace result is read through the same reader and never followed out of the result directory', async () => {
    const harness = createHarness();
    harness.client.behaviors.push({
        resultStatus: 'bundle abc',
        tamper: context => {
            context.sprite.putFile('/root/secret', 'root-only secret');
            context.sprite.put(`${FAKE_RUN_DIR}/result/result.bundle`, { type: 'symlink', target: '/root/secret' });
        },
    }, { resultStatus: 'pushed abc', resultBundle: Buffer.from('unused') });
    const linked = harness.runtime.start(cloneSpec('linked-bundle'), { timeout: 5000 });
    await linked.wait();
    assert.equal((await linked.readFile('/tmp/propr-workspace-result/status'))?.toString(), 'bundle abc\n');
    assert.equal(await linked.readFile('/tmp/propr-workspace-result/result.bundle'), null);
    assert.equal(await linked.readFile('/etc/passwd'), null);
    await linked.release();
    const pushed = harness.runtime.start(cloneSpec('pushed'), { timeout: 5000 });
    await pushed.wait();
    assert.equal(await pushed.readFile('/tmp/propr-workspace-result/result.bundle'), null, 'a pushed result needs no bundle download');
    await pushed.release();
});

test('the org token never reaches a run, a Sprite command or a log', async () => {
    const records: unknown[] = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        mock.method(logger, level, (...args: unknown[]) => { records.push(args); });
    }
    const previous = { ...process.env };
    try {
        process.env.PROPR_SPRITES_TOKEN = ORG_TOKEN;
        process.env.SPRITES_TOKEN = ORG_TOKEN;
        const harness = createHarness();
        const store = createCredentialStore(harness.root, 'claude');
        harness.client.behaviors.push({ stdout: 'ok\n' });
        const spec = cloneSpec('token', {
            credentialStore: store.directory,
            customize: builder => builder
                // Inherited by name from the worker, set literally, and smuggled inside another variable's value.
                .env('PROPR_SPRITES_TOKEN').env('SPRITES_TOKEN', ORG_TOKEN).env('MY_ALIAS', ORG_TOKEN).env('WRAPPED', `Bearer ${ORG_TOKEN}`).env('HARMLESS', 'value'),
        });
        // A failing restore exercises the error logs too.
        harness.client.behaviors[0].act = context => { context.sprite.failRestores = 1; };
        const handle = harness.runtime.start(spec, { timeout: 5000, extraEnvVars: { EXTRA: ORG_TOKEN } });
        await handle.wait();
        const sprite = harness.client.sprites.get(SPRITE)!;
        await handle.release();
        const { env } = sprite.runs[0];
        for (const name of ['PROPR_SPRITES_TOKEN', 'SPRITES_TOKEN', 'MY_ALIAS', 'WRAPPED']) assert.ok(!(name in env), `${name} is withheld`);
        assert.equal(env.HARMLESS, 'value');
        assert.equal(env.GH_TOKEN, 'gh-token-value');
        assert.ok(!JSON.stringify(env).includes(ORG_TOKEN));
        for (const candidate of harness.client.sprites.values()) {
            assert.ok(!JSON.stringify(candidate.commands).includes(ORG_TOKEN), 'no command sent to a Sprite carries the token');
            assert.ok(!JSON.stringify(candidate.setupEnvironment).includes(ORG_TOKEN));
        }
        assert.ok(!JSON.stringify(harness.client.createOptions).includes(ORG_TOKEN));
        assert.ok(records.length > 0);
        assert.ok(!JSON.stringify(records).includes(ORG_TOKEN), 'no log record carries the token');
        assert.ok(JSON.stringify(records).includes('MY_ALIAS'), 'the withheld variables are named in the log');

        // An SDK error that quotes the token is redacted before it is thrown or logged.
        const failing = createHarness({ createClient: async () => { throw new Error(`401 for Bearer ${ORG_TOKEN}`); } });
        await assert.rejects(failing.runtime.start(cloneSpec('auth'), { timeout: 5000 }).wait(), error => {
            assert.ok(!(error as Error).message.includes(ORG_TOKEN));
            assert.match((error as Error).message, /\[REDACTED\]/);
            return true;
        });
        assert.ok(!JSON.stringify(records).includes(ORG_TOKEN));
    } finally {
        mock.restoreAll();
        process.env.PROPR_SPRITES_TOKEN = previous.PROPR_SPRITES_TOKEN;
        process.env.SPRITES_TOKEN = previous.SPRITES_TOKEN;
        if (previous.PROPR_SPRITES_TOKEN === undefined) delete process.env.PROPR_SPRITES_TOKEN;
        if (previous.SPRITES_TOKEN === undefined) delete process.env.SPRITES_TOKEN;
    }
});

test('SPRITES_CLIENT_SIGNALS is switched off unless the operator set it', async () => {
    const { SpritesRuntime } = await import('../packages/core/src/agents/runtime/spritesRuntime.ts');
    const unset: NodeJS.ProcessEnv = {};
    new SpritesRuntime({ environment: unset });
    assert.equal(unset[SPRITES_CLIENT_SIGNALS_ENV], '0');
    assert.equal(process.env[SPRITES_CLIENT_SIGNALS_ENV], '0', 'the SDK reads the process environment');
    const chosen: NodeJS.ProcessEnv = { [SPRITES_CLIENT_SIGNALS_ENV]: '1' };
    new SpritesRuntime({ environment: chosen });
    assert.equal(chosen[SPRITES_CLIENT_SIGNALS_ENV], '1');
});

test('a run past its deadline is stopped, returns its partial output and still restores the Sprite', async () => {
    const harness = createHarness();
    harness.client.behaviors.push({ hang: true, stdout: 'partial\n', act: leaveEverything() });
    const handle = harness.runtime.start(cloneSpec('slow'), { timeout: 150, preserveOutputOnTimeout: true });
    const result = await handle.wait();
    assert.equal(result.timedOut, true);
    assert.equal(result.stdout, 'partial\n');
    await handle.release();
    assert.ok(harness.client.operations.includes(`signal-TERM:${SPRITE}`));
    assert.deepEqual(harness.client.sprites.get(SPRITE)!.paths(), CLEAN_PATHS);
});

test('output following resumes from the bytes already received after a dropped connection', async () => {
    const harness = createHarness();
    harness.client.behaviors.push({ stdout: 'first line\nsecond line\n' });
    const handle = harness.runtime.start(cloneSpec('dropped'), { timeout: 5000 });
    const streamed: string[] = [];
    handle.stdout.on('data', chunk => streamed.push(String(chunk)));
    while (!harness.client.sprites.get(SPRITE)) await new Promise(resolve => setImmediate(resolve));
    const sprite = harness.client.sprites.get(SPRITE)!;
    sprite.dropFollowers = 1;
    sprite.dropAfterBytes = 6;
    const result = await handle.wait();
    assert.equal(result.stdout, 'first line\nsecond line\n');
    assert.equal(streamed.join(''), 'first line\nsecond line\n');
    const offsets = sprite.commands.filter(command => command.includes('follow') && command.includes('stdout')).map(command => command.at(-1));
    assert.deepEqual(offsets, ['1', '7'], 'the second connection asked for the bytes after the six it had received');
    await handle.release();
});

test('a run that ends without an exit status is reported as interrupted and its Sprite is not reused as it is', async () => {
    const harness = createHarness();
    harness.client.behaviors.push({ stdout: 'x\n' }, {});
    const handle = harness.runtime.start(cloneSpec('lost'), { timeout: 5000 });
    while (!harness.client.sprites.get(SPRITE)) await new Promise(resolve => setImmediate(resolve));
    const sprite = harness.client.sprites.get(SPRITE)!;
    const execFile = sprite.execFile.bind(sprite);
    sprite.execFile = async (command, args = []) => args.includes('status') ? { stdout: 'running=0\nexit=\nexport=\n', stderr: '', exitCode: 0 } : execFile(command, args);
    await assert.rejects(handle.wait(), error => error instanceof SpritesRunInterruptedError);
    await handle.release();
    sprite.execFile = execFile;
    const next = harness.runtime.start(cloneSpec('next'), { timeout: 5000 });
    await next.wait();
    await next.release();
    const current = harness.client.sprites.get(SPRITE)!;
    assert.deepEqual(current.runs.at(-1)!.pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
});

test('the clone transport reads its result through the handle and releasing it leaves the Sprite clean', async () => {
    const { runWithWorkspaceTransport } = await import('../packages/core/src/git/workspaceTransport.ts');
    const harness = createHarness();
    harness.client.behaviors.push({ stdout: 'agent output\n', act: leaveEverything(), resultStatus: 'bundle abc', resultBundle: Buffer.from('BUNDLE') });
    const read: Record<string, string | undefined> = {};
    const steps: string[] = [];
    const result = await runWithWorkspaceTransport(harness.runtime, cloneSpec('transport'), { timeout: 5000, extraEnvVars: {} }, {
        transport: {
            mode: 'clone',
            prepare: async spec => ({
                spec,
                launchEnvironment: { PROPR_WORKSPACE_GIT_TOKEN: 'repository-token' },
                complete: async handle => {
                    steps.push('complete');
                    read.status = (await handle.readFile!('/tmp/propr-workspace-result/status'))?.toString();
                    handle.retain?.();
                    read.bundle = (await handle.readFile!('/tmp/propr-workspace-result/result.bundle'))?.toString();
                    return { applied: true, via: 'bundle' };
                },
                cleanup: async handle => {
                    steps.push('cleanup');
                    await handle?.release?.();
                },
            }),
        },
    });
    assert.equal(result.stdout, 'agent output\n');
    assert.deepEqual(read, { status: 'bundle abc\n', bundle: 'BUNDLE' });
    assert.deepEqual(steps, ['complete', 'cleanup']);
    const sprite = harness.client.sprites.get(SPRITE)!;
    assert.deepEqual(sprite.paths(), CLEAN_PATHS);
    assert.equal(harness.client.operations.at(-1), `restore:v1:${SPRITE}`);
});
