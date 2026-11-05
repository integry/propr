/**
 * Agent Tank 0.10 canonical response shape.
 *
 * 0.10 answers `{ providers: [{ id, provider, status, windows, raw, ... }] }`
 * with the 0.9.x per-agent payload kept under `raw`. Every ProPR consumer reads
 * that legacy `usage`, so both generations must parse to the same status map,
 * and the canonical fields (freshness, failure, windows) must win where they
 * overlap.
 */

import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTankMode } from '@propr/shared';
import type { AgentStatusResponse } from '../packages/core/src/services/agentTankTypes.js';

process.env.NODE_ENV = 'test';

await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} },
});

await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: {
        executeDockerCommand: async () => { throw new Error('external-mode tests must not start containers'); },
    },
});

let mode: AgentTankMode = 'external';
const realConfigPaths = await import('../packages/core/src/config/agentConfigPaths.js');
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        loadAgentTankSettings: async () => ({ mode, enabled: mode !== 'disabled', url: 'http://tank.test:3456' }),
        loadAgents: async () => [],
        resolveConfigPath: realConfigPaths.resolveConfigPath,
        resolveCodexConfigPath: realConfigPaths.resolveCodexConfigPath,
    },
});

const recordedSnapshots: Array<Record<string, AgentStatusResponse> | undefined> = [];
await mock.module('../packages/core/src/services/agentTankUsageHistory.js', {
    namedExports: {
        recordAgentTankUsageHistory: async (agents: Record<string, AgentStatusResponse> | undefined) => {
            recordedSnapshots.push(agents);
            return 0;
        },
    },
});

const { isUsableAgentTankStatus, parseAgentTankStatus, parseAgentTankStatusMap } =
    await import('../packages/core/src/services/agentTankTypes.js');
const { extractAgentTankUsageMetrics } = await import('../packages/core/src/services/agentTankUsageMetrics.js');
const { parseBundledAgentTankOutput } = await import('../packages/core/src/services/agentTankBundledRunner.js');
const { getAllStatuses, getStatus } = await import('../packages/core/src/services/agentTankService.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');

const CLAUDE_RAW = {
    name: 'claude',
    usage: { session: { percent: 42, resetsInSeconds: 3600 }, weeklyAll: { percent: 17 } },
    metadata: { plan: 'max' },
    lastUpdated: '2026-10-17T10:00:00.000Z',
    error: null,
};

function window(overrides: Record<string, unknown> = {}) {
    return {
        type: 'session',
        label: 'Current session',
        model: null,
        used_percent: 42,
        remaining_percent: 58,
        resets_at: '2026-10-17T11:00:00.000Z',
        resets_in_seconds: 3600,
        pace: { status: 'on_track' },
        ...overrides,
    };
}

function provider(overrides: Record<string, unknown> = {}) {
    return {
        id: 'claude',
        provider: 'claude',
        plan: 'max',
        status: 'ok',
        last_updated: '2026-10-17T10:05:00.000Z',
        error: null,
        windows: [window()],
        context_window: null,
        credits: null,
        raw: CLAUDE_RAW,
        ...overrides,
    };
}

const AGY_PROVIDER = provider({
    id: 'agy',
    provider: 'antigravity',
    plan: null,
    status: 'refreshing',
    windows: [window({ type: 'weekly', label: 'Gemini 4 Argon', model: 'Gemini 4 Argon', used_percent: 30, remaining_percent: 70 })],
    raw: { name: 'agy', usage: { models: [{ model: 'Gemini 4 Argon Weekly Limit', usageLeft: 70 }] } },
});

const CANONICAL = {
    providers: [
        provider(),
        AGY_PROVIDER,
        provider({
            id: 'codex',
            provider: 'codex',
            status: 'error',
            error: 'Timeout waiting for usage data',
            windows: [],
            raw: { name: 'codex', usage: {}, error: null },
        }),
    ],
};

const originalFetch = globalThis.fetch;
let fetchCalls: string[] = [];
let fetchBody: unknown = {};

beforeEach(() => {
    mode = 'external';
    fetchCalls = [];
    recordedSnapshots.length = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
        fetchCalls.push(input.toString());
        return new Response(JSON.stringify(fetchBody), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
});

after(async () => {
    globalThis.fetch = originalFetch;
    await closeConnection();
});

test('canonical providers parse to a map keyed by id carrying the raw legacy usage', () => {
    const agents = parseAgentTankStatusMap(CANONICAL);

    assert.deepEqual(Object.keys(agents), ['claude', 'agy', 'codex']);
    assert.equal(agents.claude.name, 'claude');
    assert.deepEqual(agents.claude.usage, CLAUDE_RAW.usage);
    assert.deepEqual(agents.claude.metadata, { plan: 'max' });
    assert.equal(agents.claude.plan, 'max');
    assert.equal(agents.claude.error, null);
    assert.equal(agents.claude.isRefreshing, undefined);
    // The canonical freshness is authoritative over the raw payload's own.
    assert.equal(agents.claude.lastUpdated, '2026-10-17T10:05:00.000Z');
});

test('canonical windows are parsed field by field, dropping unknown extras', () => {
    const [parsed] = parseAgentTankStatusMap(CANONICAL).claude.windows ?? [];
    assert.deepEqual(parsed, {
        type: 'session',
        label: 'Current session',
        model: null,
        used_percent: 42,
        remaining_percent: 58,
        resets_at: '2026-10-17T11:00:00.000Z',
        resets_in_seconds: 3600,
    });
});

test('malformed window fields degrade to defaults and nulls', () => {
    const status = parseAgentTankStatus(provider({
        windows: [{ used_percent: Number.NaN, model: 7, resets_in_seconds: '60' }, 'junk', null],
    }));
    assert.deepEqual(status?.windows, [{
        type: 'session',
        label: '',
        model: null,
        used_percent: null,
        remaining_percent: null,
        resets_at: null,
        resets_in_seconds: null,
    }]);
});

test('antigravity is keyed by its agy id, refreshing is surfaced, and windows ride along', () => {
    const agy = parseAgentTankStatusMap(CANONICAL).agy;
    assert.equal(agy.name, 'agy');
    assert.equal(agy.isRefreshing, true);
    assert.equal(agy.plan, null);
    assert.deepEqual(agy.usage, { models: [{ model: 'Gemini 4 Argon Weekly Limit', usageLeft: 70 }] });
    assert.equal(agy.windows?.[0].model, 'Gemini 4 Argon');
    assert.equal(agy.windows?.[0].used_percent, 30);
});

test('a canonical error overrides a clean raw payload', () => {
    const codex = parseAgentTankStatusMap(CANONICAL).codex;
    assert.equal(codex.error, 'Timeout waiting for usage data');
    assert.deepEqual(codex.windows, []);
    assert.equal(isUsableAgentTankStatus(codex), false);
});

test('a provider without id falls back to the provider name; one without either is dropped', () => {
    const agents = parseAgentTankStatusMap({
        providers: [provider({ id: undefined, provider: 'codex', raw: undefined }), provider({ id: '', provider: null }), 'junk'],
    });
    assert.deepEqual(Object.keys(agents), ['codex']);
    assert.equal(agents.codex.name, 'codex');
    assert.deepEqual(agents.codex.usage, {});
});

test('an empty providers list parses to an empty map', () => {
    assert.deepEqual(parseAgentTankStatusMap({ providers: [] }), {});
});

test('non-object documents parse to an empty map', () => {
    for (const value of [null, undefined, 'text', 42, [CLAUDE_RAW]]) {
        assert.deepEqual(parseAgentTankStatusMap(value), {});
    }
});

test('the 0.9.x map keyed by agent passes through unchanged', () => {
    const agents = parseAgentTankStatusMap({ claude: CLAUDE_RAW, agy: { usage: { models: [] }, isRefreshing: true }, bogus: 3 });
    assert.deepEqual(Object.keys(agents), ['claude', 'agy']);
    assert.deepEqual(agents.claude, {
        name: 'claude',
        usage: CLAUDE_RAW.usage,
        metadata: { plan: 'max' },
        lastUpdated: '2026-10-17T10:00:00.000Z',
        error: null,
    });
    assert.equal(agents.agy.name, 'agy');
    assert.equal(agents.agy.isRefreshing, true);
    assert.equal(agents.agy.windows, undefined);
});

test('an { agents: {...} } envelope around the legacy map is unwrapped', () => {
    const agents = parseAgentTankStatusMap({ agents: { claude: CLAUDE_RAW } });
    assert.deepEqual(Object.keys(agents), ['claude']);
    assert.deepEqual(agents.claude.usage, CLAUDE_RAW.usage);
});

test('bundled --once output with banner lines before canonical JSON parses', () => {
    const stdout = `Agent Tank v0.10.0\nRefreshing 2 providers...\n${JSON.stringify(CANONICAL, null, 2)}\n`;
    const agents = parseBundledAgentTankOutput(stdout);
    assert.deepEqual(Object.keys(agents), ['claude', 'agy', 'codex']);
    assert.equal(agents.agy.isRefreshing, true);
    assert.equal(agents.claude.windows?.length, 1);
});

test('bundled output that is empty, brace-less or broken parses to an empty map', () => {
    assert.deepEqual(parseBundledAgentTankOutput(''), {});
    assert.deepEqual(parseBundledAgentTankOutput('no json here'), {});
    assert.deepEqual(parseBundledAgentTankOutput('banner\n{"providers": ['), {});
});

test('windows with a used percentage are usable even when legacy usage is empty', () => {
    const base: AgentStatusResponse = { name: 'claude', usage: {} };
    assert.equal(isUsableAgentTankStatus(base), false);
    assert.equal(isUsableAgentTankStatus({ ...base, windows: [window({ used_percent: null })] as never }), false);
    assert.equal(isUsableAgentTankStatus({ ...base, windows: [window({ used_percent: 0 })] as never }), true);
    assert.equal(
        isUsableAgentTankStatus({ ...base, error: 'boom', windows: [window()] as never }),
        false,
        'an error still disqualifies a status that carries windows',
    );
});

test('external getAllStatuses reads the 0.10 shape, maps agy to antigravity and records history', async () => {
    fetchBody = CANONICAL;
    const agents = await getAllStatuses();

    assert.deepEqual(fetchCalls, ['http://tank.test:3456/status']);
    assert.deepEqual(Object.keys(agents ?? {}).sort(), ['antigravity', 'claude', 'codex']);
    assert.equal(agents?.antigravity.name, 'antigravity');
    assert.equal(agents?.antigravity.isRefreshing, true);
    assert.deepEqual(agents?.claude.usage, CLAUDE_RAW.usage);
    assert.equal(agents?.codex.error, 'Timeout waiting for usage data');
    assert.deepEqual(recordedSnapshots, [agents]);
});

test('external getStatus reads one canonical provider object', async () => {
    fetchBody = AGY_PROVIDER;
    const status = await getStatus('antigravity');

    assert.deepEqual(fetchCalls, ['http://tank.test:3456/status/agy']);
    assert.equal(status.name, 'antigravity');
    assert.equal(status.isRefreshing, true);
    assert.equal(status.windows?.[0].model, 'Gemini 4 Argon');
    assert.deepEqual(status.usage, { models: [{ model: 'Gemini 4 Argon Weekly Limit', usageLeft: 70 }] });
});

test('external getStatus still accepts a bare 0.9.x payload', async () => {
    fetchBody = { usage: { session: { percent: 9 } } };
    const status = await getStatus('claude');

    assert.equal(status.name, 'claude');
    assert.deepEqual(status.usage, { session: { percent: 9 } });
    assert.equal(status.windows, undefined);
});

test('external getStatus rejects a document that is not an object', async () => {
    fetchBody = [1, 2];
    await assert.rejects(() => getStatus('claude'), /unreadable status document/);
});

test('claude usage flattens to one percentage row per known section', () => {
    const rows = extractAgentTankUsageMetrics('claude', {
        session: { percent: 42.456 },
        weeklyAll: { percent: 17, label: 'All models' },
        weeklyFable: { percent: 120 },
        weeklySonnet: { percent: 'n/a' },
        extraUsage: { percent: 99 },
    });
    assert.deepEqual(rows, [
        { key: 'session', label: 'Current session', model: null, cycle: 'session', percentUsed: 42.46 },
        { key: 'weeklyAll', label: 'All models', model: null, cycle: 'weekly', percentUsed: 17 },
        { key: 'weeklyFable', label: 'Current week (Fable)', model: 'Fable', cycle: 'weekly', percentUsed: 100 },
    ]);
});

test('codex usage reads percentUsed or percentLeft, including per-model limits', () => {
    const rows = extractAgentTankUsageMetrics('codex', {
        fiveHour: { percentUsed: 12 },
        weekly: { percentLeft: 75 },
        credits: { balance: 40 },
        modelLimits: [
            { name: 'GPT-6 Spark', fiveHour: { percentLeft: 90 }, weekly: { percentUsed: 5, label: 'Week' } },
            { fiveHour: { percentUsed: 1 } },
            'junk',
        ],
    });
    assert.deepEqual(rows, [
        { key: 'fiveHour', label: '5h limit', model: null, cycle: 'five_hour', percentUsed: 12 },
        { key: 'weekly', label: 'Weekly limit', model: null, cycle: 'weekly', percentUsed: 25 },
        { key: 'GPT-6 Spark:fiveHour', label: 'GPT-6 Spark 5h limit', model: 'GPT-6 Spark', cycle: 'five_hour', percentUsed: 10 },
        { key: 'GPT-6 Spark:weekly', label: 'GPT-6 Spark Week', model: 'GPT-6 Spark', cycle: 'weekly', percentUsed: 5 },
        { key: 'Model:fiveHour', label: 'Model 5h limit', model: 'Model', cycle: 'five_hour', percentUsed: 1 },
    ]);
});

test('antigravity models derive usage from usageLeft and keep the Gemini 4 Argon group', () => {
    const usage = {
        models: [
            { model: 'Gemini 4 Argon Weekly Limit', group: 'Gemini 4 Argon', cycle: 'weekly', usageLeft: 70, percentUsed: 30 },
            { model: 'Gemini 3 Pro', cycle: 'fiveHour', percentUsed: 55 },
            { model: 'Claude Fable', cycle: 'unknown', usageLeft: 100 },
            { model: '', usageLeft: 10 },
            { model: 'No data' },
        ],
    };
    const expected = [
        { key: 'model:Gemini 4 Argon Weekly Limit', label: 'Gemini 4 Argon Weekly Limit', model: 'Gemini 4 Argon', cycle: 'weekly', percentUsed: 30 },
        { key: 'model:Gemini 3 Pro', label: 'Gemini 3 Pro', model: 'Gemini 3 Pro', cycle: 'five_hour', percentUsed: 55 },
        { key: 'model:Claude Fable', label: 'Claude Fable', model: 'Claude Fable', cycle: 'session', percentUsed: 0 },
    ];
    // Both the ProPR name and the Agent Tank id select the antigravity extractor.
    assert.deepEqual(extractAgentTankUsageMetrics('antigravity', usage), expected);
    assert.deepEqual(extractAgentTankUsageMetrics('agy', usage), expected);
});

test('unknown agents and non-object usage produce no metrics', () => {
    assert.deepEqual(extractAgentTankUsageMetrics('cursor', { session: { percent: 5 } }), []);
    assert.deepEqual(extractAgentTankUsageMetrics('claude', null), []);
    assert.deepEqual(extractAgentTankUsageMetrics('claude', [{ percent: 5 }]), []);
    assert.deepEqual(extractAgentTankUsageMetrics('antigravity', { models: 'none' }), []);
});
