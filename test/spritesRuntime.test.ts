import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock, test } from 'node:test';
import { FAKE_RUN_DIR, type FakeSprite } from './helpers/fakeSprites.ts';
import { cloneSpec, createCredentialStore, createHarness, liveTokenPath, ORG_TOKEN, TEST_BUNDLE } from './helpers/spritesHarness.ts';

const { AgentRunStoppedError } = await import('../packages/core/src/agents/runtime/agentRunOutput.ts');
const { SpritesRunInterruptedError } = await import('../packages/core/src/agents/runtime/spritesRuntime.ts');
const { SPRITES_CLIENT_SIGNALS_ENV } = await import('../packages/core/src/agents/runtime/sprites/spritesConfig.ts');
const { default: logger } = await import('../packages/core/src/utils/logger.ts');

const { tryAcquireSpriteLock } = await import('../packages/core/src/agents/runtime/sprites/spritesLock.ts');

const SPRITE = 'propr-w1-0';
const CONTENDER = fileURLToPath(new URL('./helpers/spritesLockContender.ts', import.meta.url));
const CLEAN_PATHS = ['/', '/home', '/home/node', '/home/node/workspace', '/opt', '/opt/propr', '/opt/propr/bin', '/opt/propr/entrypoints', '/opt/propr/launcher.sh', '/opt/propr/run', '/opt/propr/sprites-setup.hash', '/tmp', '/var', '/var/lib', '/var/lib/propr', '/var/lib/propr/run'];

/** What a run leaves behind: the #3786 findings were each of these reaching the next run. */
function leaveEverything(agent: 'claude' | 'antigravity' = 'claude') {
    return (context: { write(file: string, content: string): void }) => {
        context.write('/home/node/workspace/src/secret.txt', 'workspace of run 1');
        context.write('/home/node/workspace/.git/config', 'origin');
        context.write('/tmp/claude-logs/session.jsonl', 'log of run 1');
        context.write('/home/node/.cache-scratch/notes', 'scratch of run 1');
        // /tmp is not part of a Sprite's checkpoint: the restore alone would leave these.
        context.write('/tmp/leftover-by-agent', 'tmp of run 1');
        context.write('/tmp/propr-workspace-transport.abc/repo.git/HEAD', 'scratch of the clone wrapper');
        context.write('/var/lib/propr/run/scratch-by-agent', 'TMPDIR of run 1');
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
    assert.deepEqual(harness.client.operations, [`create:${SPRITE}`, `setup:${SPRITE}`, `checkpoint:v1:${SPRITE}`, `run:run-1:${SPRITE}`, `scrub:${SPRITE}`, `restore:v1:${SPRITE}`]);
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
    assert.deepEqual(harness.client.operations.slice(6), [`run:run-2:${SPRITE}`, `scrub:${SPRITE}`, `restore:v1:${SPRITE}`]);
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
    assert.ok(!sprite.runs[1].pathsAtLaunch.some(file => file.includes('antigravity-home') || file.startsWith('/home/node/.gemini')));
    // The disposable HOME, with the oauth token in it, is on the checkpointed root: never under /tmp, which no restore resets.
    assert.ok(liveTokenPath('antigravity').startsWith('/var/lib/propr/run/antigravity-home/'));
});

test('/tmp is not part of the checkpoint: it is emptied before every restore, and run-scoped directories are kept off it', async () => {
    const harness = createHarness();
    const store = createCredentialStore(harness.root, 'claude');
    let duringRun: string[] = [];
    harness.client.behaviors.push({
        act: context => {
            leaveEverything()(context);
            context.write('/tmp/claude-logs/propr-operator/question.json', 'exchange of run 1');
            duringRun = context.sprite.paths();
        },
    }, {}, {});
    const first = harness.runtime.start(cloneSpec('run-1', { credentialStore: store.directory }), { timeout: 5000 });
    await first.wait();
    const sprite = harness.client.sprites.get(SPRITE)!;
    // The run's TMPDIR and the clone wrapper's result directory are on the checkpointed root.
    assert.equal(sprite.runs[0].env.TMPDIR, '/var/lib/propr/run');
    assert.equal(sprite.runs[0].env.PROPR_WORKSPACE_CLONE_RESULT_DIR, `${FAKE_RUN_DIR}/result`);
    // The log directory the run was given under /tmp is only a link there; what the run wrote to it is on the root.
    assert.equal(sprite.files.get('/tmp/claude-logs'), undefined, 'gone with the scrub');
    assert.ok(duringRun.includes('/tmp/claude-logs') && !duringRun.some(file => file.startsWith('/tmp/claude-logs/')));
    assert.ok(duringRun.some(file => /^\/var\/lib\/propr\/mounts\/\d+\/session\.jsonl$/.test(file)));
    assert.ok(duringRun.some(file => /^\/var\/lib\/propr\/mounts\/\d+\/propr-operator\/question\.json$/.test(file)));
    // What the agent wrote straight to /tmp was there until the scrub; the restore alone would have kept it.
    assert.ok(duringRun.includes('/tmp/leftover-by-agent'));
    await first.release();
    assert.deepEqual(sprite.paths(), CLEAN_PATHS);
    const order = harness.client.operations.filter(operation => /^(run|scrub|restore)/.test(operation));
    assert.deepEqual(order, [`run:run-1:${SPRITE}`, `scrub:${SPRITE}`, `restore:v1:${SPRITE}`], 'the scrub ran after the run and before the restore');

    const second = harness.runtime.start(cloneSpec('run-2', { credentialStore: store.directory }), { timeout: 5000 });
    await second.wait();
    await second.release();
    assert.deepEqual(sprite.runs[1].pathsAtLaunch.filter(file => file.startsWith('/tmp')), ['/tmp'], 'run 2 found /tmp empty');

    // A fake Sprite restored WITHOUT the scrub keeps /tmp, as a real one does: the model the test above relies on.
    sprite.putFile('/tmp/kept-by-restore', 'x');
    sprite.putFile('/home/node/dropped-by-restore', 'x');
    await sprite.restoreCheckpoint('v1');
    assert.ok(sprite.files.has('/tmp/kept-by-restore') && !sprite.files.has('/home/node/dropped-by-restore'));
    sprite.remove('/tmp/kept-by-restore');
});

test('a Sprite whose /tmp cannot be emptied is destroyed, not restored', async () => {
    const harness = createHarness();
    let original!: FakeSprite;
    harness.client.behaviors.push({ act: context => { original = context.sprite; leaveEverything()(context); context.sprite.failScrubs = 1; } }, {});
    const first = harness.runtime.start(cloneSpec('run-1'), { timeout: 5000 });
    await first.wait();
    await first.release();
    assert.equal(first.timings.recycleAction, 'replaced');
    assert.deepEqual(harness.client.operations.slice(3), [
        `run:run-1:${SPRITE}`, `scrub-failed:${SPRITE}`, `delete:${SPRITE}`, `create:${SPRITE}`, `setup:${SPRITE}`, `checkpoint:v1:${SPRITE}`,
    ]);
    const replacement = harness.client.sprites.get(SPRITE)!;
    assert.notEqual(replacement.id, original.id);
    const second = harness.runtime.start(cloneSpec('run-2'), { timeout: 5000 });
    await second.wait();
    await second.release();
    assert.equal(original.runs.length, 1, 'the Sprite with leftovers in /tmp never ran again');
    assert.deepEqual(replacement.runs[0].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
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
        `run:run-1:${SPRITE}`, `scrub:${SPRITE}`, `restore-failed:v1:${SPRITE}`, `delete:${SPRITE}`, `create:${SPRITE}`, `setup:${SPRITE}`, `checkpoint:v1:${SPRITE}`,
    ]);
    const replacement = harness.client.sprites.get(SPRITE)!;
    assert.notEqual(replacement.id, original.id);
    const second = harness.runtime.start(cloneSpec('run-2'), { timeout: 5000 });
    await second.wait();
    await second.release();
    assert.equal(original.runs.length, 1, 'the unrestorable Sprite never ran again');
    assert.deepEqual(replacement.runs[0].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
});

test('a failed setup reaches the operator with the setup script\'s own message', async () => {
    const harness = createHarness();
    harness.client.failSetups = 1;
    const errors: string[] = [];
    const logged = mock.method(logger, 'error', (fields: { error?: string }) => { if (fields?.error) errors.push(fields.error); });
    try {
        const first = harness.runtime.start(cloneSpec('run-1'), { timeout: 5000 });
        // The run that needed the Sprite fails with the exit status and the tail of the setup's stderr, not a generic message.
        await assert.rejects(first.wait(), /Sprite propr-w1-0 setup failed \(exit 1\): ProPR Sprite setup: npm install failed/);
        await first.release();
        // So does a replacement after a run, which no run waits for: it is logged.
        harness.client.behaviors.push({ act: context => { context.sprite.failRestores = 1; harness.client.failSetups = 1; } });
        const second = harness.runtime.start(cloneSpec('run-2'), { timeout: 5000 });
        await second.wait();
        await second.release();
        assert.equal(second.timings.recycleAction, 'failed');
        assert.ok(errors.some(error => /setup failed \(exit 1\): ProPR Sprite setup: npm install failed/.test(error)), errors.join('\n'));
    } finally {
        logged.mock.restore();
    }
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

/** A separate worker process competing for a Sprite's lock; `said(word)` resolves once it printed that line. */
function contender(lockFile: string, mode = '5'): { child: ChildProcess; said(word: string): Promise<void>; exited: Promise<void>; output(): string } {
    const child = spawn(process.execPath, [...process.execArgv, CONTENDER, lockFile, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    const waiting: Array<() => void> = [];
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); waiting.splice(0).forEach(check => check()); });
    const exited = new Promise<void>(resolve => child.once('exit', () => { resolve(); waiting.splice(0).forEach(check => check()); }));
    const said = (word: string): Promise<void> => new Promise((resolve, reject) => {
        const check = (): void => {
            if (output.split('\n').includes(word)) resolve();
            else if (child.exitCode !== null || child.signalCode !== null) reject(new Error(`the contender exited without saying "${word}" (said: ${JSON.stringify(output)})`));
            else waiting.push(check);
        };
        check();
    });
    return { child, said, exited, output: () => output };
}

async function kill(...contenders: Array<{ child: ChildProcess; exited: Promise<void> }>): Promise<void> {
    for (const { child } of contenders) child.kill('SIGKILL');
    await Promise.all(contenders.map(({ exited }) => exited));
}

test('a Sprite locked by another live worker process is not used, and is taken once that process is gone', async () => {
    const harness = createHarness({ maxSprites: 1 });
    fs.mkdirSync(harness.stateDir, { recursive: true });
    const lock = path.join(harness.stateDir, `${SPRITE}.lock`);
    const other = contender(lock);
    try {
        await other.said('held');
        const handle = harness.runtime.start(cloneSpec('waiting'), { timeout: 30_000 });
        for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(harness.client.operations.length, 0, 'the Sprite of the other process is left alone');
        // The lock is the other process's only while it lives: no file content has to be judged stale.
        await kill(other);
        await handle.wait();
        await handle.release();
        assert.equal(harness.client.sprites.get(SPRITE)!.runs.length, 1);
    } finally {
        await kill(other);
    }
});

test('worker processes competing for the lock of a dead owner: exactly one takes it, every time', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-sprites-lock-'));
    const lock = path.join(root, 'state', `${SPRITE}.lock`);
    const contenders = Array.from({ length: 6 }, () => contender(lock, '1'));
    const alive = new Set(contenders);
    try {
        await Promise.all(contenders.map(each => each.said('ready')));
        // Each round the owner dies holding the lock and every surviving process races to take it over.
        while (alive.size > 0) {
            await Promise.race([...alive].map(each => each.said('held')));
            // Long enough for a second process to (wrongly) get in: each tries every millisecond.
            await new Promise(resolve => setTimeout(resolve, 150));
            const holders = [...alive].filter(each => each.output().includes('held'));
            assert.equal(holders.length, 1, `${holders.length} live processes hold the lock at once`);
            // While it is held, neither this process nor a new one gets it.
            assert.equal(tryAcquireSpriteLock(lock), undefined);
            const late = contender(lock, 'once');
            await late.said('busy');
            await late.exited;
            alive.delete(holders[0]);
            await kill(holders[0]);
        }
        // Nobody is left: the lock of the last dead owner is free, and one process cannot take it twice.
        const mine = tryAcquireSpriteLock(lock);
        assert.ok(mine);
        assert.equal(tryAcquireSpriteLock(lock), undefined);
        mine.release();
        const again = tryAcquireSpriteLock(lock);
        assert.ok(again);
        again.release();
    } finally {
        await kill(...contenders);
    }
});

test('what a worker knew of a Sprite ends with its lock: after another holder, the Sprite is checked again before a run', async () => {
    // Two worker processes sharing the worker id and state directory, the second on a newer setup.
    const harness = createHarness();
    const upgraded = createHarness({ root: harness.root, client: harness.client, bundle: { ...TEST_BUNDLE, hash: 'setuphash0000002' } });
    const run = async (runtime: typeof harness.runtime, name: string) => {
        const handle = runtime.start(cloneSpec(name), { timeout: 5000 });
        await handle.wait();
        await handle.release();
        const sprite = harness.client.sprites.get(SPRITE)!;
        return { handle, sprite, launchedOn: sprite.setupEnvironment.PROPR_SPRITES_SETUP_HASH };
    };
    const first = await run(harness.runtime, 'old-1');
    assert.equal(first.launchedOn, TEST_BUNDLE.hash);
    const second = await run(upgraded.runtime, 'new-1');
    assert.equal(second.launchedOn, 'setuphash0000002');
    assert.notEqual(second.sprite.id, first.sprite.id);

    // The first worker left its Sprite clean, but that Sprite is gone: it must not launch on the other setup's CLIs.
    const third = await run(harness.runtime, 'old-2');
    assert.equal(third.launchedOn, TEST_BUNDLE.hash, 'the run started on a Sprite set up for the bundle its worker validated');
    assert.notEqual(third.sprite.id, second.sprite.id);
    assert.equal(second.sprite.runs.length, 1, 'nothing more ran on the Sprite of the other setup');
    assert.equal(typeof third.handle.timings.provisionMs, 'number');
    const fourth = await run(upgraded.runtime, 'new-2');
    assert.equal(fourth.launchedOn, 'setuphash0000002');
    assert.equal(third.sprite.runs.length, 1);

    // Uninterrupted ownership is still trusted: the same worker's next run needs neither a restore nor a provision.
    const fifth = await run(upgraded.runtime, 'new-3');
    assert.equal(fifth.sprite.id, fourth.sprite.id);
    assert.equal(fifth.handle.timings.provisionMs, undefined);
    assert.equal(fifth.handle.timings.restoreMs, undefined);
});

test('a Sprite another worker with the same setup held meanwhile is restored before the next run, not trusted', async () => {
    const harness = createHarness();
    const run = async (runtime: typeof harness.runtime, name: string) => {
        const handle = runtime.start(cloneSpec(name), { timeout: 5000 });
        await handle.wait();
        await handle.release();
        return handle;
    };
    await run(harness.runtime, 'a-1');
    const sprite = harness.client.sprites.get(SPRITE)!;
    await run(harness.restart(), 'b-1');
    // The other worker died mid-run after that: its files are on the Sprite, whose identity and setup are unchanged.
    sprite.putFile('/home/node/workspace/abandoned.txt', 'left by the other worker');
    const next = await run(harness.runtime, 'a-2');
    assert.equal(harness.client.sprites.get(SPRITE)!.id, sprite.id);
    assert.deepEqual(sprite.runs[2].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
    assert.equal(typeof next.timings.restoreMs, 'number');
});

test('a run whose launcher saw agent processes survive gets its Sprite destroyed, even though the launcher exited', async () => {
    const harness = createHarness();
    let original!: FakeSprite;
    harness.client.behaviors.push({ act: context => { original = context.sprite; leaveEverything()(context); }, exportState: 'unsafe', stdout: 'done\n' }, {});
    const handle = harness.runtime.start(cloneSpec('survivors'), { timeout: 5000 });
    const result = await handle.wait();
    assert.equal(result.exitCode, 0);
    await handle.release();
    // The launcher's exit status alone was not taken for "everything is gone": a kill was still attempted.
    assert.ok(harness.client.operations.includes(`signal-KILL:${SPRITE}`));
    assert.equal(handle.timings.recycleAction, 'replaced');
    assert.ok(harness.client.operations.includes(`delete:${SPRITE}`));
    assert.ok(!harness.client.operations.some(operation => operation.startsWith('restore:')), 'the Sprite was not restored for reuse');
    const next = harness.runtime.start(cloneSpec('after'), { timeout: 5000 });
    await next.wait();
    await next.release();
    assert.notEqual(harness.client.sprites.get(SPRITE)!.id, original.id);
    assert.equal(original.runs.length, 1);
});

test('the deadline covers the wait for a free Sprite: a queued run times out and is never launched', async () => {
    const harness = createHarness({ maxSprites: 1 });
    harness.client.behaviors.push({ hang: true }, {});
    const first = harness.runtime.start(cloneSpec('busy'), { timeout: 30_000 });
    const firstOutcome = first.wait().catch(error => error);
    while (!harness.client.sprites.get(SPRITE)?.runs.length) await new Promise(resolve => setImmediate(resolve));
    const started = Date.now();
    const preserved = harness.runtime.start(cloneSpec('queued-preserved'), { timeout: 80, preserveOutputOnTimeout: true });
    const rejected = harness.runtime.start(cloneSpec('queued'), { timeout: 80 });
    const result = await preserved.wait();
    assert.equal(result.timedOut, true);
    assert.equal(result.timeoutMs, 80);
    assert.equal(result.exitCode, null);
    await assert.rejects(rejected.wait(), /Command timed out after 80ms/);
    assert.ok(Date.now() - started < 5000, 'the queued runs did not wait for the Sprite');
    await Promise.all([preserved.release(), rejected.release()]);
    assert.equal(harness.client.sprites.get(SPRITE)!.runs.length, 1, 'neither expired run reached the Sprite');
    await first.stop();
    await firstOutcome;
    await first.release();
});

test('the deadline covers a Sprite held by another worker process', async () => {
    const harness = createHarness({ maxSprites: 1 });
    const other = contender(path.join(harness.stateDir, `${SPRITE}.lock`));
    try {
        await other.said('held');
        const handle = harness.runtime.start(cloneSpec('locked-out'), { timeout: 80 });
        await assert.rejects(handle.wait(), /Command timed out after 80ms/);
        await handle.release();
        assert.equal(harness.client.operations.length, 0);
    } finally {
        await kill(other);
    }
});

test('the deadline covers preparation: a run that expires while its Sprite is provisioned is not launched, and the Sprite is not shared meanwhile', async () => {
    const harness = createHarness({ maxSprites: 1 });
    let provisioned!: () => void;
    const slowSetup = new Promise<void>(resolve => { provisioned = resolve; });
    const createSprite = harness.client.createSprite.bind(harness.client);
    let creations = 0;
    harness.client.createSprite = async (name, options) => {
        if (creations++ === 0) await slowSetup;
        return createSprite(name, options);
    };
    const expired = harness.runtime.start(cloneSpec('expires-in-setup'), { timeout: 400, preserveOutputOnTimeout: true });
    assert.equal((await expired.wait()).timedOut, true);
    await expired.release();
    // The provisioning nobody waits for still owns the Sprite: the next run queues behind it instead of provisioning alongside.
    const next = harness.runtime.start(cloneSpec('next'), { timeout: 30_000 });
    for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(creations, 1);
    provisioned();
    await next.wait();
    await next.release();
    const sprite = harness.client.sprites.get(SPRITE)!;
    assert.equal(creations, 1, 'the Sprite provisioned for the expired run serves the next one');
    assert.deepEqual(sprite.runs.map(run => run.env.PROPR_TEST_RUN), ['next']);
});

test('the deadline covers the payload upload: no session starts after it, and the Sprite is restored once the upload settled', async () => {
    const harness = createHarness({ maxSprites: 1 });
    const warm = harness.runtime.start(cloneSpec('warm'), { timeout: 5000 });
    await warm.wait();
    await warm.release();
    const sprite = harness.client.sprites.get(SPRITE)!;
    let finishUpload!: () => void;
    const held = new Promise<void>(resolve => { finishUpload = resolve; });
    const filesystem = sprite.filesystem.bind(sprite);
    let uploads = 0;
    sprite.filesystem = () => {
        const real = filesystem();
        return { ...real, writeFile: async (file: string, data: string | Buffer, options?: { mode?: number }) => { if (uploads++ === 0) await held; return real.writeFile(file, data, options); } };
    };
    const store = createCredentialStore(harness.root, 'claude');
    const handle = harness.runtime.start(cloneSpec('expires-in-upload', { credentialStore: store.directory }), { timeout: 400 });
    await assert.rejects(handle.wait(), /Command timed out after 400ms/);
    const sessions = () => sprite.commands.filter(command => command.includes('run')).length;
    const before = sessions();
    let released = false;
    const release = handle.release().then(() => { released = true; });
    const next = harness.runtime.start(cloneSpec('next'), { timeout: 30_000 });
    for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, false, 'the Sprite is not given back while the upload is in flight');
    assert.equal(sprite.runs.length, 1, 'the next run does not start on a Sprite an upload may still land on');
    finishUpload();
    await release;
    assert.equal(handle.timings.recycleAction, 'restored');
    await next.wait();
    await next.release();
    assert.equal(sessions(), before + 1, 'only the next run started a session');
    // The expired run's payload (its credentials) landed late and was wiped by the restore before the next run.
    assert.deepEqual(sprite.runs.map(run => run.env.PROPR_TEST_RUN), ['warm', 'next']);
    assert.deepEqual(sprite.runs[1].pathsAtLaunch, [...CLEAN_PATHS, `${FAKE_RUN_DIR}/payload.tar`].sort());
    assert.deepEqual(sprite.paths(), CLEAN_PATHS);
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
