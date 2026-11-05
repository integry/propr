/**
 * Agent Tank settings migration.
 *
 * Every existing installation has a persisted `{ enabled, url }` record written
 * before bundled mode existed. These assertions are what guarantee those
 * installations keep pointing at exactly the same Agent Tank after upgrading.
 */

import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: {
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
    },
});

let storedConfig: unknown;
let storedKey: string | undefined;

await mock.module('../packages/core/src/config/configStore.js', {
    namedExports: {
        getConfig: async <T>(_key: string, fallback: T): Promise<T> =>
            (storedConfig === undefined ? fallback : storedConfig as T),
        saveConfig: async (key: string, value: unknown): Promise<void> => {
            storedKey = key;
            storedConfig = value;
        },
    },
});

const {
    loadAgentTankSettings,
    normalizeAgentTankSettings,
    saveAgentTankSettings,
} = await import('../packages/core/src/config/configManagerAgents.js');

const originalMode = process.env.AGENT_TANK_MODE;
const originalUrl = process.env.AGENT_TANK_URL;

beforeEach(() => {
    storedConfig = undefined;
    storedKey = undefined;
    delete process.env.AGENT_TANK_MODE;
    delete process.env.AGENT_TANK_URL;
});

afterEach(() => {
    if (originalMode === undefined) delete process.env.AGENT_TANK_MODE;
    else process.env.AGENT_TANK_MODE = originalMode;
    if (originalUrl === undefined) delete process.env.AGENT_TANK_URL;
    else process.env.AGENT_TANK_URL = originalUrl;
});

test('a legacy enabled record migrates to external mode without changing its URL', async () => {
    storedConfig = { enabled: true, url: 'http://host.docker.internal:3456' };

    const settings = await loadAgentTankSettings();

    assert.equal(settings.mode, 'external');
    assert.equal(settings.url, 'http://host.docker.internal:3456');
    assert.equal(settings.enabled, true);
});

test('a legacy disabled record migrates to disabled mode', async () => {
    storedConfig = { enabled: false, url: 'http://0.0.0.0:3456' };

    const settings = await loadAgentTankSettings();

    assert.equal(settings.mode, 'disabled');
    assert.equal(settings.enabled, false);
});

test('a fresh install with no record defaults to disabled', async () => {
    const settings = await loadAgentTankSettings();

    assert.equal(settings.mode, 'disabled');
    assert.equal(settings.enabled, false);
});

test('a corrupt mode degrades to disabled rather than breaking settings loading', () => {
    assert.equal(normalizeAgentTankSettings({ mode: 'sideways' }).mode, 'disabled');
    assert.equal(normalizeAgentTankSettings({ mode: 42 }).mode, 'disabled');
    assert.equal(normalizeAgentTankSettings(null).mode, 'disabled');
});

test('AGENT_TANK_MODE only applies when no record exists at all', () => {
    process.env.AGENT_TANK_MODE = 'bundled';

    assert.equal(normalizeAgentTankSettings({}).mode, 'bundled');
    // A persisted record always wins over the environment fallback.
    assert.equal(normalizeAgentTankSettings({ enabled: false }).mode, 'disabled');
    assert.equal(normalizeAgentTankSettings({ mode: 'external' }).mode, 'external');
});

test('an unrecognized AGENT_TANK_MODE degrades to disabled', () => {
    process.env.AGENT_TANK_MODE = 'sideways';

    assert.equal(normalizeAgentTankSettings({}).mode, 'disabled');
});

test('AGENT_TANK_URL supplies the URL when none is persisted', () => {
    process.env.AGENT_TANK_URL = 'http://127.0.0.1:9999';

    assert.equal(normalizeAgentTankSettings({ mode: 'external' }).url, 'http://127.0.0.1:9999');
});

test('saving persists the canonical shape including a derived enabled boolean', async () => {
    await saveAgentTankSettings({ mode: 'bundled', url: 'http://0.0.0.0:3456' });

    assert.equal(storedKey, 'agent_tank');
    assert.deepEqual(storedConfig, { mode: 'bundled', enabled: true, url: 'http://0.0.0.0:3456' });

    // A rollback to an older build must read a sane boolean, not a surprise.
    await saveAgentTankSettings({ mode: 'disabled', url: 'http://0.0.0.0:3456' });
    assert.deepEqual(storedConfig, { mode: 'disabled', enabled: false, url: 'http://0.0.0.0:3456' });
});

test('saving ignores a caller-supplied enabled flag that contradicts the mode', async () => {
    await saveAgentTankSettings({ mode: 'disabled', enabled: true, url: 'http://0.0.0.0:3456' });

    assert.deepEqual(storedConfig, { mode: 'disabled', enabled: false, url: 'http://0.0.0.0:3456' });
});
