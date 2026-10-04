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
/**
 * Snapshots keyed by the alias whose credentials produced them - the runner only
 * inspects one account per provider, so this is what an alias-specific read is
 * allowed to see.
 */
let bundledSnapshotsByAlias: Record<string, AgentStatusResponse> = {};
await mock.module('../packages/core/src/services/agentTankBundledRunner.js', {
    namedExports: {
        getBundledStatusesForDelta: () => bundledSnapshot,
        getBundledStatusForAlias: (alias: string) => bundledSnapshotsByAlias[alias],
        refreshBundledStatuses: async () => bundledSnapshot,
        scheduleBundledRefresh: () => { scheduledRefreshes += 1; },
    },
});

const {
    getAllStatuses,
    getStatus,
    getStatusForAlias,
    normalizeAgentTankAgents,
    normalizeAgentTankStatus,
    refreshAgent,
    toAgentTankAgent,
    toProprAgent,
} = await import('../packages/core/src/services/agentTankService.js');

const { AliasSpecificAgentTankSnapshotProvider } =
    await import('../packages/core/src/services/syntheticUsageSnapshotProvider.js');

const { closeConnection } = await import('../packages/core/src/db/connection.js');

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];

beforeEach(() => {
    mode = 'disabled';
    scheduledRefreshes = 0;
    bundledSnapshot = undefined;
    bundledSnapshotsByAlias = {};
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

test('bundled mode answers an alias-specific read only for the inspected account', async () => {
    mode = 'bundled';
    // Two Claude accounts with `claude-secondary` configured first: provider
    // dedup means only that account was inspected, even though Agent Tank labels
    // the snapshot with the provider key `claude`.
    const status: AgentStatusResponse = {
        name: 'claude',
        usage: { session: { percent: 5 } },
        lastUpdated: new Date().toISOString(),
    };
    bundledSnapshot = { claude: status };
    bundledSnapshotsByAlias = { 'claude-secondary': status };

    // Alias `claude` is a different account, so it gets nothing rather than the
    // secondary account's capacity.
    await assert.rejects(() => getStatusForAlias('claude'), /No fresh bundled Agent Tank snapshot for alias claude/);
    // The verified answer is named after the account that produced it, not after
    // the provider key the bundled id is pinned to - alias consumers match the
    // name exactly.
    assert.equal((await getStatusForAlias('claude-secondary')).name, 'claude-secondary');
    // Renaming must copy, never edit the cached snapshot in place.
    assert.equal(status.name, 'claude');
    assert.deepEqual(fetchCalls, []);
});

test('alias-specific capacity is withheld when the snapshot belongs to another account of the same provider', async () => {
    mode = 'bundled';
    const status: AgentStatusResponse = {
        name: 'claude',
        usage: { session: { percent: 5 }, weekly: { percent: 11 } },
        lastUpdated: new Date().toISOString(),
    };
    bundledSnapshot = { claude: status };
    bundledSnapshotsByAlias = { 'claude-secondary': status };

    const provider = new AliasSpecificAgentTankSnapshotProvider();

    // Without provenance the name check alone would pass here, because the
    // bundled id is pinned to the provider key.
    assert.equal(await provider.getSnapshot('claude'), null);
});

test('alias-specific capacity is reported for the account that was actually inspected', async () => {
    mode = 'bundled';
    bundledSnapshotsByAlias = {
        claude: {
            name: 'claude',
            usage: { session: { percent: 5 }, weekly: { percent: 11 } },
            lastUpdated: new Date().toISOString(),
        },
    };

    const snapshot = await new AliasSpecificAgentTankSnapshotProvider().getSnapshot('claude');

    assert.equal(snapshot?.directAgentAlias, 'claude');
    assert.equal(snapshot?.sessionPercent, 5);
    assert.equal(snapshot?.weeklyPercent, 11);
});

test('alias-specific capacity is reported for a custom alias that was actually inspected', async () => {
    mode = 'bundled';
    // A custom alias is the case the provider-keyed snapshot name cannot satisfy
    // on its own: Agent Tank labels this snapshot `claude`, but it was produced
    // by `claude-secondary`'s credentials and must route capacity for it.
    bundledSnapshotsByAlias = {
        'claude-secondary': {
            name: 'claude',
            usage: { session: { percent: 7 }, weekly: { percent: 13 } },
            lastUpdated: new Date().toISOString(),
        },
    };

    const snapshot = await new AliasSpecificAgentTankSnapshotProvider().getSnapshot('claude-secondary');

    assert.equal(snapshot?.directAgentAlias, 'claude-secondary');
    assert.equal(snapshot?.sessionPercent, 7);
    assert.equal(snapshot?.weeklyPercent, 13);
});

test('an alias-specific read in external mode still asks the daemon by name', async () => {
    mode = 'external';

    await getStatusForAlias('antigravity');

    assert.deepEqual(fetchCalls, ['http://0.0.0.0:3456/status/agy']);
});

test('external per-call probes keep the provider endpoint when given a custom account alias', async () => {
    mode = 'external';
    await getStatus('antigravity', undefined, 'antigravity-secondary');
    assert.deepEqual(fetchCalls, ['http://0.0.0.0:3456/status/agy']);
});
