import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// The setting is read through the shared SQLite connection; point it at a throwaway database first.
const dataDir = await mkdtemp(path.join(tmpdir(), 'propr-idle-setting-'));
process.env.DATA_DIR = dataDir;
delete process.env.DB_FILENAME;

const { IDLE_SHUTDOWN_SETTING, IDLE_STATUS_REDIS_KEY } = await import('@propr/shared');
const { db } = await import('../src/db/connection.js');
const { loadIdleShutdownConfig, loadStoredIdleShutdownSetting } = await import('../src/idle/idleShutdownSetting.js');
const { emptyIdleSignals } = await import('../src/idle/idleDetector.js');
const { IdleShutdownController } = await import('../src/idle/idleShutdownController.js');

const MINUTE = 60_000;
const ENABLED_BY_ENV = { PROPR_IDLE_SHUTDOWN: 'on' };

if (!await db.schema.hasTable('system_configs')) {
    await db.schema.createTable('system_configs', table => {
        table.string('key').primary();
        table.text('value');
        table.timestamps(true, true);
    });
}

after(async () => {
    await db.destroy();
    await rm(dataDir, { recursive: true, force: true });
});

async function storeRaw(value: string | null): Promise<void> {
    await db('system_configs').where({ key: IDLE_SHUTDOWN_SETTING }).delete();
    if (value !== null) await db('system_configs').insert({ key: IDLE_SHUTDOWN_SETTING, value });
}

test('an absent setting is no setting; a well-formed one applies', async () => {
    await storeRaw(null);
    assert.equal(await loadStoredIdleShutdownSetting(), null);
    assert.deepEqual(await loadIdleShutdownConfig(ENABLED_BY_ENV), { enabled: true, afterMs: 15 * MINUTE, source: 'environment', warnings: [] });
    await storeRaw(JSON.stringify({ enabled: true, afterMs: 30 * MINUTE }));
    assert.deepEqual(await loadIdleShutdownConfig({}), { enabled: true, afterMs: 30 * MINUTE, source: 'settings', warnings: [] });
});

test('a stored setting that is valid JSON but malformed is unreadable, not absent', async () => {
    for (const malformed of [
        { enabled: true, afterMs: 'invalid' },
        { enabled: 'yes', afterMs: 30 * MINUTE },
        { enabled: true, afterMs: 10_000 },
        { enabled: true },
        [],
        'on',
    ]) {
        await storeRaw(JSON.stringify(malformed));
        await assert.rejects(loadStoredIdleShutdownSetting(), /malformed/, JSON.stringify(malformed));
        // The environment switch alone must not authorize a default 15-minute window.
        await assert.rejects(loadIdleShutdownConfig(ENABLED_BY_ENV), /malformed/, JSON.stringify(malformed));
    }
});

test('an environment-enabled instance with a malformed stored setting never stops', async () => {
    await storeRaw(JSON.stringify({ enabled: true, afterMs: 'invalid' }));
    let now = Date.UTC(2026, 10, 24, 8, 0, 0);
    const strings = new Map<string, string>();
    const requests: unknown[] = [];
    const redis = {
        async scan(): Promise<[string, string[]]> { return ['0', []]; },
        async llen() { return 0; },
        async zcard() { return 0; },
        async zrange() { return []; },
        async get(key: string) { return strings.get(key) ?? null; },
        async set(key: string, value: string) { strings.set(key, value); return 'OK'; },
        async hgetall() { return {}; },
        async hset() { return 1; },
        async hdel() { return 0; },
    };
    const controller = new IdleShutdownController({
        redis,
        now: () => now,
        resolveConfig: () => loadIdleShutdownConfig(ENABLED_BY_ENV),
        collect: async () => emptyIdleSignals(),
        onIdle: async request => { requests.push(request); return true; },
    });
    for (let i = 0; i < 4; i += 1) {
        await controller.tick();
        now += 10 * MINUTE;
    }
    assert.equal(requests.length, 0, 'no shutdown after the default window');
    const status = JSON.parse(strings.get(IDLE_STATUS_REDIS_KEY) ?? 'null');
    assert.equal(status.idle, false);
    assert.equal(status.idleSince, null);
    assert.ok(status.blockers.some((blocker: { signal: string; detail: string }) => blocker.signal === 'unavailable' && /idle shutdown setting/.test(blocker.detail)));

    // Repaired: a whole new window, counted from the first readable tick.
    await storeRaw(JSON.stringify({ enabled: true, afterMs: 15 * MINUTE }));
    await controller.tick();
    now += 14 * MINUTE;
    await controller.tick();
    assert.equal(requests.length, 0);
    now += MINUTE;
    await controller.tick();
    assert.equal(requests.length, 1);
});
