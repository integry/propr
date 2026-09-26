import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

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

import type { AgentTankMode } from '@propr/shared';
import type { AgentStatusResponse } from '../packages/core/src/services/agentTankTypes.js';

let mode: AgentTankMode = 'disabled';
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        loadAgentTankSettings: async () => ({
            mode,
            enabled: mode !== 'disabled',
            url: 'http://0.0.0.0:3456',
        }),
    },
});

let scheduledRefreshes = 0;
let bundledSnapshot: Record<string, AgentStatusResponse> | undefined;
await mock.module('../packages/core/src/services/agentTankBundledRunner.js', {
    namedExports: {
        getBundledStatusesForDelta: () => bundledSnapshot,
        refreshBundledStatuses: async () => bundledSnapshot,
        scheduleBundledRefresh: () => { scheduledRefreshes += 1; },
    },
});

const {
    getAllStatuses,
    getStatus,
    normalizeAgentTankAgents,
    normalizeAgentTankStatus,
    refreshAgent,
    toAgentTankAgent,
    toProprAgent,
} = await import('../packages/core/src/services/agentTankService.js');

const { closeConnection } = await import('../packages/core/src/db/connection.js');

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];

beforeEach(() => {
    mode = 'disabled';
    scheduledRefreshes = 0;
    bundledSnapshot = undefined;
    fetchCalls = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        fetchCalls.push(input.toString());
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
});

after(async () => {
    globalThis.fetch = originalFetch;
    await closeConnection();
});

test('maps ProPR antigravity alias to Agent Tank agy key', () => {
    assert.equal(toAgentTankAgent('antigravity'), 'agy');
});

test('maps Agent Tank agy key back to ProPR antigravity alias', () => {
    assert.equal(toProprAgent('agy'), 'antigravity');
});

test('leaves Agent Tank provider keys unchanged', () => {
    assert.equal(toAgentTankAgent('agy'), 'agy');
    assert.equal(toAgentTankAgent('claude'), 'claude');
    assert.equal(toAgentTankAgent('codex'), 'codex');
});

test('normalizes individual Agent Tank status responses to ProPR names', () => {
    assert.equal(normalizeAgentTankStatus({ name: 'agy', usage: {} }).name, 'antigravity');
});

test('normalizes Agent Tank usage maps to ProPR keys and names', () => {
    const normalized = normalizeAgentTankAgents({
        agy: { name: 'agy', usage: { models: [] } },
        claude: { name: 'claude', usage: {} },
    });

    assert.deepEqual(Object.keys(normalized).sort(), ['antigravity', 'claude']);
    assert.equal(normalized.antigravity.name, 'antigravity');
});

test('disabled mode contacts nothing at all', async () => {
    await refreshAgent('claude');
    await assert.rejects(() => getStatus('claude'), /disabled/);
    assert.equal(await getAllStatuses(), undefined);

    assert.deepEqual(fetchCalls, []);
    assert.equal(scheduledRefreshes, 0);
});

test('bundled mode never issues an HTTP request', async () => {
    mode = 'bundled';
    bundledSnapshot = { claude: { name: 'claude', usage: { session: { percent: 5 } } } };

    // refreshAgent only schedules: the hot path must not wait on a container.
    await refreshAgent('claude');
    assert.equal(scheduledRefreshes, 1);

    const status = await getStatus('claude');
    assert.equal(status.name, 'claude');

    const all = await getAllStatuses();
    assert.deepEqual(Object.keys(all ?? {}), ['claude']);
    assert.deepEqual(fetchCalls, []);
});

test('bundled mode with a cold cache throws so no usage delta is recorded', async () => {
    mode = 'bundled';
    bundledSnapshot = undefined;

    await assert.rejects(() => getStatus('claude'), /No fresh bundled Agent Tank snapshot/);
});

test('external mode still talks HTTP to the configured daemon', async () => {
    mode = 'external';

    await refreshAgent('antigravity');
    await getStatus('antigravity');
    await getAllStatuses();

    assert.deepEqual(fetchCalls, [
        'http://0.0.0.0:3456/refresh/agy',
        'http://0.0.0.0:3456/status/agy',
        'http://0.0.0.0:3456/status',
    ]);
    assert.equal(scheduledRefreshes, 0);
});
