import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import {
    DEFAULT_TOKEN_OUTLIER_SETTINGS, TOKEN_OUTLIER_MIN_HISTORY, parseTokenOutlierSetting, type TokenOutlierSettings,
} from '@propr/shared';
import { loadTokenOutlierSettings } from '../packages/core/src/config/tokenOutlierSettings.ts';
import {
    TOKEN_SAMPLES_TABLE, describeTokenOutlierAlert, evaluateTokenOutlier, loadTokenOutlierAutomationPause, medianTokens,
    readTokenBaseline, recordTokenUsageSample, type TokenOutlierAlert, type TokenUsageSample,
} from '../packages/core/src/utils/tokenOutlierAlert.ts';
import { createAgentRunCostGate } from '../packages/core/src/services/agents/agentRunCostGate.ts';
import type { StoredAgentDefinition } from '../packages/core/src/services/agents/agentDefinitionStore.ts';

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const NOW = new Date('2026-11-12T12:00:00.000Z');
const HOUR = 3_600_000;

let db: Knex;
let alerts: TokenOutlierAlert[];
let settings: TokenOutlierSettings;
let clock: Date;

before(async () => {
    db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.migrate.latest({ directory: migrations });
});

after(async () => {
    await db.destroy();
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
});

beforeEach(async () => {
    await db(TOKEN_SAMPLES_TABLE).delete();
    await db('llm_executions').delete();
    alerts = [];
    settings = { ...DEFAULT_TOKEN_OUTLIER_SETTINGS };
    clock = NOW;
});

const deps = () => ({
    database: db,
    now: () => clock,
    loadSettings: async () => settings,
    notify: async (alert: TokenOutlierAlert) => { alerts.push(alert); },
});

async function record(overrides: Partial<TokenUsageSample> = {}) {
    const [row] = await db('llm_executions').insert({
        task_id: null, start_time: clock.toISOString(), model_name: overrides.model ?? 'claude-opus-5-5', success: overrides.success ?? true,
    }).returning('execution_id');
    const executionId = Number((row as { execution_id: number }).execution_id ?? row);
    return recordTokenUsageSample({
        executionId, taskId: 'task-1', repository: 'acme/widgets', model: 'claude-opus-5-5', executionType: 'implementation',
        success: true, totalTokens: 1_000_000, number: 42, kind: 'issue', ...overrides,
    }, deps());
}

/** Successful runs of `tokens` each, on their own tasks so none of them is deduplicated. */
async function seedBaseline(count: number, tokens = 1_000_000, overrides: Partial<TokenUsageSample> = {}) {
    for (let index = 0; index < count; index++) await record({ taskId: `baseline-${index}`, totalTokens: tokens, ...overrides });
}

describe('baseline computation', () => {
    test('the median handles odd, even and empty histories', () => {
        assert.equal(medianTokens([]), 0);
        assert.equal(medianTokens([5, 1, 3]), 3);
        assert.equal(medianTokens([10, 1, 4, 2]), 3);
    });

    test('only the last N successful executions of the same repository, model and execution type count', async () => {
        settings.token_outlier_baseline_runs = 8;
        await seedBaseline(3, 9_000_000);
        await seedBaseline(8, 1_000_000);
        await record({ taskId: 'failed', success: false, totalTokens: 50_000_000 });
        await record({ taskId: 'other-model', model: 'gpt-5.5', totalTokens: 70_000_000 });
        await record({ taskId: 'other-type', executionType: 'pr-review', totalTokens: 70_000_000 });
        await record({ taskId: 'other-repo', repository: 'acme/gadgets', totalTokens: 70_000_000 });

        const history = await readTokenBaseline(db, { repository: 'ACME/Widgets', model: 'claude-opus-5-5', executionType: 'implementation' }, 8);
        assert.deepEqual(history, Array(8).fill(1_000_000));
    });

    test('an execution is never part of its own baseline', async () => {
        await seedBaseline(TOKEN_OUTLIER_MIN_HISTORY);
        const result = await record({ taskId: 'big', totalTokens: 10_000_000 });
        assert.equal(result.evaluation.status, 'outlier');
        assert.equal(result.evaluation.status === 'outlier' && result.evaluation.baselineTokens, 1_000_000);
    });
});

describe('threshold', () => {
    const thresholds = { token_outlier_multiplier: 4, token_outlier_min_tokens: 500_000, token_outlier_baseline_runs: 20 };
    const history = Array(10).fill(200_000);

    test('fires above the multiple of the baseline and the absolute floor', () => {
        assert.equal(evaluateTokenOutlier(800_001, history, thresholds).status, 'outlier');
        assert.equal(evaluateTokenOutlier(800_000, history, thresholds).status, 'within_baseline');
    });

    test('small runs never alert, however far above a small baseline', () => {
        const evaluation = evaluateTokenOutlier(500_000, Array(10).fill(1_000), thresholds);
        assert.equal(evaluation.status, 'below_floor');
    });

    test('the multiple is the instance setting', async () => {
        await seedBaseline(TOKEN_OUTLIER_MIN_HISTORY);
        settings.token_outlier_multiplier = 10;
        assert.equal((await record({ taskId: 'nine-times', totalTokens: 9_000_000 })).alerted, false);
        settings.token_outlier_multiplier = 4;
        assert.equal((await record({ taskId: 'five-times', totalTokens: 5_000_000 })).alerted, true);
    });
});

describe('minimum-history guard', () => {
    test(`no alert before ${TOKEN_OUTLIER_MIN_HISTORY} successful executions, even with a larger configured window`, async () => {
        await seedBaseline(TOKEN_OUTLIER_MIN_HISTORY - 1);
        await record({ taskId: 'failed', success: false });
        const early = await record({ taskId: 'early', totalTokens: 100_000_000 });
        assert.deepEqual(early, { evaluation: { status: 'insufficient_history', samples: TOKEN_OUTLIER_MIN_HISTORY - 1 }, alerted: false });
        assert.deepEqual(alerts, []);

        // The early outlier was successful, so it now completes the history.
        const next = await record({ taskId: 'next', totalTokens: 100_000_000 });
        assert.equal(next.alerted, true);
    });

    test('the guard applies to the evaluation directly', () => {
        assert.equal(evaluateTokenOutlier(1e9, Array(7).fill(1), { token_outlier_multiplier: 4, token_outlier_min_tokens: 1_000, token_outlier_baseline_runs: 20 }).status, 'insufficient_history');
    });
});

describe('alert and deduplication', () => {
    test('the alert states observed versus baseline and links to the task', async () => {
        await seedBaseline(TOKEN_OUTLIER_MIN_HISTORY);
        const result = await record({ taskId: 'task-big', totalTokens: 6_000_000, number: 77, kind: 'pull_request' });
        assert.equal(result.alerted, true);
        assert.equal(alerts.length, 1);
        assert.equal(alerts[0].sample.taskId, 'task-big');
        assert.equal(alerts[0].baselineTokens, 1_000_000);
        assert.equal(alerts[0].ratio, 6);
        assert.equal(alerts[0].pause, null);
        const { title, body } = describeTokenOutlierAlert(alerts[0], 'Claude Opus 5.5');
        assert.equal(title, 'Unusually high token use for PR #77');
        assert.match(body, /^Used 6M tokens, 6× the baseline of 1M \(median of the last 8 successful implementation runs of Claude Opus 5\.5 in acme\/widgets; alert above 4×\)\.$/);
    });

    test('one alert per task: later outlier runs of the same task stay quiet', async () => {
        await seedBaseline(TOKEN_OUTLIER_MIN_HISTORY);
        assert.equal((await record({ taskId: 'task-big', totalTokens: 6_000_000 })).alerted, true);
        assert.equal((await record({ taskId: 'task-big', totalTokens: 7_000_000 })).alerted, false);
        assert.equal(alerts.length, 1);
        assert.equal(await db(TOKEN_SAMPLES_TABLE).whereNotNull('alerted_at').count({ count: '*' }).first().then(row => Number(row?.count)), 1);
    });

    test('an execution without a task is recorded for the baseline but cannot alert', async () => {
        await seedBaseline(TOKEN_OUTLIER_MIN_HISTORY);
        const result = await record({ taskId: null, totalTokens: 60_000_000 });
        assert.equal(result.evaluation.status, 'outlier');
        assert.equal(result.alerted, false);
        assert.deepEqual(alerts, []);
    });
});

describe('automation pause', () => {
    const definition = { id: 'def-1', repositories: ['acme/widgets'], agentAlias: null, modelName: null } as unknown as StoredAgentDefinition;

    test('is off by default, however many alerts there are', async () => {
        await seedBaseline(TOKEN_OUTLIER_MIN_HISTORY);
        for (const taskId of ['a', 'b', 'c']) await record({ taskId, totalTokens: 60_000_000 });
        assert.equal(alerts.length, 3);
        assert.equal(await loadTokenOutlierAutomationPause(['acme/widgets'], deps()), null);
    });

    test('pauses the repository after M alerts within the window, and lifts when the window passes', async () => {
        settings.token_outlier_pause_alerts = 2;
        settings.token_outlier_pause_window_hours = 6;
        await seedBaseline(TOKEN_OUTLIER_MIN_HISTORY);
        await record({ taskId: 'a', totalTokens: 60_000_000 });
        assert.equal(alerts[0].pause, null);
        assert.equal(await loadTokenOutlierAutomationPause(['acme/widgets'], deps()), null);

        clock = new Date(NOW.getTime() + HOUR);
        await record({ taskId: 'b', totalTokens: 60_000_000 });
        assert.deepEqual(alerts[1].pause, { alerts: 2, windowHours: 6 });
        assert.match(describeTokenOutlierAlert(alerts[1], 'Claude Opus 5.5').body, /Scheduled automations for acme\/widgets are paused: 2 token alerts in the last 6 h\./);
        assert.deepEqual(await loadTokenOutlierAutomationPause(['acme/other', 'Acme/Widgets'], deps()), { repository: 'Acme/Widgets', alerts: 2, threshold: 2, windowHours: 6 });
        assert.equal(await loadTokenOutlierAutomationPause(['acme/other'], deps()), null);

        clock = new Date(NOW.getTime() + 6.5 * HOUR);
        assert.equal(await loadTokenOutlierAutomationPause(['acme/widgets'], deps()), null);
    });

    test('the cost gate skips scheduled runs of a paused repository only', async () => {
        const pause = { repository: 'acme/widgets', alerts: 3, threshold: 3, windowHours: 24 };
        const seen: string[][] = [];
        const gate = createAgentRunCostGate({
            loadThreshold: async () => 90,
            evaluateCapacity: async () => ({ status: 'ok', provider: 'claude' }),
            loadTokenOutlierPause: async repositories => { seen.push(repositories); return pause; },
        });
        const scheduled = await gate({ definition, trigger: 'schedule', triggerSource: null });
        assert.equal(scheduled?.action, 'skip');
        assert.match(scheduled && 'reason' in scheduled ? scheduled.reason : '', /Scheduled automations for acme\/widgets are paused: 3 runs used far more tokens than usual in the last 24 h/);
        assert.deepEqual(seen, [['acme/widgets']]);
        for (const trigger of ['manual', 'api', 'mcp', 'cli'] as const) {
            assert.deepEqual(await gate({ definition, trigger, triggerSource: null }), { action: 'proceed' }, trigger);
        }

        const failing = createAgentRunCostGate({
            loadThreshold: async () => 90,
            evaluateCapacity: async () => ({ status: 'ok', provider: 'claude' }),
            loadTokenOutlierPause: async () => { throw new Error('database unavailable'); },
        });
        assert.deepEqual(await failing({ definition, trigger: 'schedule', triggerSource: null }), { action: 'proceed' });
    });
});

describe('settings', () => {
    test('values are validated against their ranges', () => {
        assert.equal(parseTokenOutlierSetting('token_outlier_multiplier', 2.5), 2.5);
        assert.equal(parseTokenOutlierSetting('token_outlier_multiplier', '6'), 6);
        assert.equal(parseTokenOutlierSetting('token_outlier_multiplier', 1), null);
        assert.equal(parseTokenOutlierSetting('token_outlier_baseline_runs', 7), null);
        assert.equal(parseTokenOutlierSetting('token_outlier_baseline_runs', 20.5), null);
        assert.equal(parseTokenOutlierSetting('token_outlier_pause_alerts', 0), 0);
        assert.equal(parseTokenOutlierSetting('token_outlier_pause_window_hours', 0), null);
        assert.equal(parseTokenOutlierSetting('token_outlier_min_tokens', 'lots'), null);
        assert.equal(parseTokenOutlierSetting('token_outlier_min_tokens', true), null);
    });

    test('the loader returns stored values and falls back to defaults for missing, invalid or unreadable ones', async () => {
        const stored: Record<string, unknown> = { token_outlier_multiplier: 6, token_outlier_baseline_runs: 3, token_outlier_pause_alerts: 2 };
        const loaded = await loadTokenOutlierSettings({
            readConfig: async <T>(key: string, fallback: T): Promise<T> => {
                if (key === 'token_outlier_pause_window_hours') throw new Error('unreadable');
                return (key in stored ? stored[key] : fallback) as T;
            },
        });
        assert.deepEqual(loaded, {
            token_outlier_multiplier: 6, token_outlier_min_tokens: 500_000, token_outlier_baseline_runs: 20,
            token_outlier_pause_alerts: 2, token_outlier_pause_window_hours: 24,
        });
        assert.deepEqual(DEFAULT_TOKEN_OUTLIER_SETTINGS, {
            token_outlier_multiplier: 4, token_outlier_min_tokens: 500_000, token_outlier_baseline_runs: 20,
            token_outlier_pause_alerts: 0, token_outlier_pause_window_hours: 24,
        });
    });

    test('the settings route validates and saves each setting', async () => {
        const { extractSettingSaves } = await import('../packages/api/routes/configSettings.ts');
        const saved = await extractSettingSaves({ token_outlier_multiplier: 5, token_outlier_pause_alerts: 3, token_outlier_pause_window_hours: '12' });
        assert.equal(saved.error, undefined);
        assert.deepEqual(saved.normalized, { token_outlier_multiplier: 5, token_outlier_pause_alerts: 3, token_outlier_pause_window_hours: 12 });
        assert.deepEqual(saved.saves, [{ name: 'token_outlier_multiplier' }, { name: 'token_outlier_pause_alerts' }, { name: 'token_outlier_pause_window_hours' }]);
        assert.equal((await extractSettingSaves({ token_outlier_baseline_runs: 4 })).error, 'token_outlier_baseline_runs must be an integer from 8 to 200');
        assert.equal((await extractSettingSaves({ token_outlier_multiplier: null })).error, 'token_outlier_multiplier must be a number from 1.5 to 100');
    });

    test('the CLI parses each setting', async () => {
        const { parseSettingValue, isValidSettingKey } = await import('../packages/cli/src/api/settings.ts');
        assert.equal(isValidSettingKey('token_outlier_pause_alerts'), true);
        assert.equal(parseSettingValue('token_outlier_multiplier', '4.5'), 4.5);
        assert.equal(parseSettingValue('token_outlier_pause_alerts', '0'), 0);
        assert.throws(() => parseSettingValue('token_outlier_baseline_runs', '5'), /Invalid value for token_outlier_baseline_runs: must be an integer from 8 to 200/);
    });
});
