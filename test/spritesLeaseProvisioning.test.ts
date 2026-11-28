import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import Redis from 'ioredis-mock';
import { pino } from 'pino';
import { spritePoolKey } from '@propr/shared';
import { closeConnection, db } from '../packages/core/src/db/connection.ts';
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { indexCheckedAgentRuntimePackages } from '../packages/core/src/agents/runtime/agentRuntimePackageIndex.ts';
import { SpritesRuntime } from '../packages/core/src/agents/runtime/spritesRuntime.ts';
import { WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import logger, { createCorrelatedLogger } from '../packages/core/src/utils/logger.ts';
import { FakeSpriteOrganization, type FakeSprite } from './helpers/fakeSprites.ts';

after(closeConnection);
const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-lease-'));
after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
const token = 'test-org-secret';
// The inventory's Redis lease: three minutes, renewed every five seconds.
const LEASE_TTL_MS = 3 * 60_000;
let port = 9500;

const spec = () => new AgentRunSpecBuilder({
    name: 'test', stdin: true, agentType: 'antigravity', image: 'test', network: agentRunNetwork('bridge'), user: '0:0',
    workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
        clone: { remote: 'unused', baseRef: 'base', baseCommit: 'unused', branch: 'test', resultDir: '/tmp/propr-workspace-result', script: WORKSPACE_TRANSPORT_SCRIPT } },
}).command('agy', '--version').build();

/**
 * A fake clock for everything the lease depends on: Redis key expiry (Date), the renewal interval
 * and local expiry timer (setInterval/setTimeout) and the local deadline (performance.now()).
 */
async function fakeClock(t: TestContext) {
    // Open the database pool on real timers: under a mocked setTimeout its first acquire would wait
    // out the pool's real 60 s acquire timeout and hold the process open at exit.
    await db.raw('select 1');
    // Same for the pino-pretty transport: on its worker's READY it polls with setTimeout for the
    // lines logged so far to drain before it unrefs the worker. A slow worker start that lands under
    // the mocked clock loses that poll when the mock is reset, and the ref'd worker never lets the
    // process exit.
    const transport = createCorrelatedLogger('sprites-lease-test')[pino.symbols.streamSym] as unknown as { ready?: boolean } & NodeJS.EventEmitter;
    if (transport.ready === false) await once(transport, 'ready');
    // Collected rather than printed, so a test can assert on them.
    const logs: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        t.mock.method(logger, level, (fields: Record<string, unknown>, message: string) => { logs.push({ level, fields, message }); });
    }
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
    const origin = Date.now();
    t.mock.method(performance, 'now', () => 1_000_000 + Date.now() - origin);
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
    /** Fake time passing in one-second steps until `work` settles. */
    const runUntil = async <T>(work: Promise<T>, limitMs = 60 * 60_000) => {
        let settled = false;
        void work.then(() => { settled = true; }, () => { settled = true; });
        await flush();
        for (let elapsed = 0; !settled && elapsed < limitMs; elapsed += 1000) {
            t.mock.timers.tick(1000);
            await flush();
        }
        assert.ok(settled, 'still pending after the time limit');
        return work;
    };
    return { runUntil, logs };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Agent setup and the runtime package install each take `ms` of fake time on every new Sprite. */
function slowProvisioning(provider: FakeSpriteOrganization, { setupMs, installMs }: { setupMs: number; installMs: number }) {
    provider.setup = (sprite: FakeSprite) => {
        const exec = sprite.execFile.bind(sprite);
        sprite.execFile = async (cmd, args, options) => {
            if (args.some(arg => arg.endsWith('/sprites-agent-setup.sh'))) await sleep(setupMs);
            if (args.includes('figlet')) await sleep(installMs);
            return exec(cmd, args, options);
        };
    };
}

function runtime(t: TestContext, provider: FakeSpriteOrganization, packages = indexCheckedAgentRuntimePackages(async () => ['figlet'], async () => {})) {
    const redis = new Redis({ port: port++ });
    const environment = { DATA_DIR: fs.mkdtempSync(path.join(markerDir, 'install-')), PROPR_SPRITES_TOKEN: token, PROPR_SPRITES_MAX: '1' };
    const sprites = new SpritesRuntime(provider, environment, redis, packages);
    t.after(() => sprites.close());
    const lease = async (name: string) => ({ holder: await redis.get(spritePoolKey() + ':lease:' + name), ttl: await redis.pttl(spritePoolKey() + ':lease:' + name) });
    return { sprites, redis, lease };
}

test('a run whose own setup and package install outlast the lease TTL keeps its lease and starts its agent on that Sprite', async t => {
    const { runUntil } = await fakeClock(t);
    const provider = new FakeSpriteOrganization();
    // Four minutes of provisioning against a three-minute lease.
    slowProvisioning(provider, { setupMs: 2 * 60_000, installMs: 2 * 60_000 });
    const { sprites, lease } = runtime(t, provider);
    const started = Date.now();
    const run = sprites.start(spec());
    const result = await runUntil(run.wait());
    assert.ok(Date.now() - started >= LEASE_TTL_MS + 60_000, 'provisioning took a minute longer than the lease TTL');
    assert.equal(result.exitCode, 0);
    assert.equal(provider.created.length, 1);
    const [sprite] = provider.created;
    assert.equal(sprite.launches.length, 1, 'the agent started on the Sprite the run provisioned');
    assert.deepEqual(sprite.events, ['checkpoint', 'restore', 'launch']);
    assert.deepEqual(provider.deleted, []);
    // Still the run's: renewed throughout, so it has nearly a full TTL left.
    const held = await lease(sprite.name);
    assert.ok(held.holder, 'the run still holds the Redis lease');
    assert.ok(held.ttl > LEASE_TTL_MS - 15_000, `lease TTL ${held.ttl} ms`);
    assert.equal((await run.readFile!('/tmp/propr-workspace-result/status')), null);
    await runUntil(run.release!());
});

test('a slow package availability check before the reservation does not use up the create window', async t => {
    const { runUntil } = await fakeClock(t);
    const provider = new FakeSpriteOrganization();
    slowProvisioning(provider, { setupMs: 1000, installMs: 1000 });
    // A cold package index download: longer than the reservation's create window.
    const packages = indexCheckedAgentRuntimePackages(async () => ['figlet'], () => sleep(90_000));
    const { sprites } = runtime(t, provider, packages);
    const run = sprites.start(spec());
    assert.equal((await runUntil(run.wait())).exitCode, 0);
    assert.equal(provider.created[0].launches.length, 1);
    await runUntil(run.release!());
});

test('a provisioning failure after the Sprite exists is reported as itself, not as an expired lease', async t => {
    const provider = new FakeSpriteOrganization();
    provider.setup = sprite => { sprite.failRestore = true; };
    const { sprites, lease } = runtime(t, provider);
    const run = sprites.start(spec());
    await assert.rejects(run.wait(), (error: Error) => {
        assert.match(error.message, /Failed to provision the clean Sprite checkpoint: restore failed/);
        assert.doesNotMatch(error.message, /lease/);
        return true;
    });
    assert.deepEqual(provider.deleted, [provider.created[0].name]);
    assert.equal((await lease(provider.created[0].name)).holder, null);
});

test('a lost lease names its holder and expiry in the run error and the log', async t => {
    const { runUntil, logs } = await fakeClock(t);
    const provider = new FakeSpriteOrganization();
    let taken = false;
    provider.setup = sprite => {
        const exec = sprite.execFile.bind(sprite);
        sprite.execFile = async (cmd, args, options) => {
            // Another holder takes the key mid-install; the next renewal finds out.
            if (args.includes('figlet') && !taken) {
                taken = true;
                await redis.set(spritePoolKey() + ':lease:' + sprite.name, 'other-worker', 'PX', 60_000);
                await sleep(30_000);
            }
            return exec(cmd, args, options);
        };
    };
    const { sprites, redis } = runtime(t, provider);
    const run = sprites.start(spec());
    await assert.rejects(runUntil(run.wait()),
        /Sprite lease expired for propr-[0-9a-f-]+: Redis refused to renew the lease; the Redis lease is held by other-worker \(expires in \d+ ms\)/);
    const fields = logs.find(({ level, message }) => level === 'warn' && message === 'Sprite lease expired')?.fields;
    assert.ok(fields, 'logged the expiry');
    assert.equal(fields.sprite, provider.created[0].name);
    assert.equal(fields.holder, 'other-worker');
    assert.ok(typeof fields.ttlMs === 'number' && fields.ttlMs > 0 && fields.ttlMs <= 60_000);
    assert.equal(typeof fields.owner, 'string');
    assert.notEqual(fields.owner, 'other-worker');
    assert.equal(typeof fields.lastRenewedMsAgo, 'number');
    assert.equal(typeof fields.localDeadlineInMs, 'number');
    // Not this worker's to delete any more.
    assert.deepEqual(provider.deleted, []);
});
