import { after, test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import * as configManager from '@propr/core';
import { applyAgentsUpdate, createAgentsRoutes } from '../packages/api/routes/configRoutesAgents.ts';
import { normalizeAgentsConfig, resolveConfigStore, withConfigLock } from '../packages/api/routes/configHelpers.ts';
import {
    queueResummarizationForAllRepos,
    stopIndexingJob
} from '../packages/api/routes/indexingQueueHelpers.ts';
import { createConfigRoutes } from '../packages/api/routes/configRoutes.ts';
import { prepareAgentsUpdate } from '../packages/api/routes/configRoutesAgentsPreparation.ts';
import { saveSettingsWithRollback } from '../packages/api/routes/configRoutesSettings.ts';
import { appendClaudeUserMessageEvents, parseClaudeOutputToConversationResult, parseCodexOutputToConversationResult } from '../packages/api/routes/liveDetailsCodexParser.ts';
import { parseOpenCodeOutputToConversationResult } from '../packages/api/routes/liveDetailsOpenCodeParser.ts';
import {
    detectStoredOutputFormat,
    findLatestHistoryEntryWithSessionId,
    parseStoredOutputContent,
} from '../packages/api/routes/liveDetailsRoutes.ts';
import { parseRedisOutput } from '../packages/api/services/redisOutputParser.ts';

after(async () => {
    await configManager.closeConnection();
    await configManager.shutdownQueue();
});

describe('config route follow-up helpers', () => {
    let currentSettings: Record<string, unknown>;
    let currentAgents: Array<Record<string, unknown>>;
    let currentAutoFollowup = 4;
    let currentAutoResolveMergeConflicts = false;
    let currentPrReviewModel = '';
    let currentUltrafixRatingGoal = 7;
    let currentUltrafixMaxCycles = 5;
    let currentUltrafixPauseSeconds = 60;
    let failAutoFollowupSave = false;
    let configWriteFailure: ((key: string, value: unknown) => Error | null) | null;

    function createTestDatabase() {
        return {
            transaction: async () => {
                let stagedSettings = structuredClone(currentSettings);
                let stagedAgents = structuredClone(currentAgents);
                let stagedAutoFollowup = currentAutoFollowup;
                let stagedAutoResolve = currentAutoResolveMergeConflicts;
                let stagedPrReviewModel = currentPrReviewModel;
                let stagedUltrafixGoal = currentUltrafixRatingGoal;
                let stagedUltrafixCycles = currentUltrafixMaxCycles;
                let stagedUltrafixPause = currentUltrafixPauseSeconds;
                const trx = Object.assign(
                    ((_table: string) => ({
                        insert: (row: { key: string; value: string }) => ({
                            onConflict: () => ({
                                merge: async () => {
                                    const value = JSON.parse(row.value) as unknown;
                                    const failure = configWriteFailure?.(row.key, value);
                                    if (failure) throw failure;
                                    if (row.key === 'settings') stagedSettings = value as Record<string, unknown>;
                                    else if (row.key === 'agents') stagedAgents = value as Array<Record<string, unknown>>;
                                    else if (row.key === 'auto_followup_score_threshold') stagedAutoFollowup = value as number;
                                    else if (row.key === 'auto_resolve_merge_conflicts') stagedAutoResolve = value as boolean;
                                    else if (row.key === 'pr_review_model') stagedPrReviewModel = value as string;
                                    else if (row.key === 'ultrafix_rating_goal') stagedUltrafixGoal = value as number;
                                    else if (row.key === 'ultrafix_max_cycles') stagedUltrafixCycles = value as number;
                                    else if (row.key === 'ultrafix_pause_seconds') stagedUltrafixPause = value as number;
                                },
                            }),
                        }),
                    })) as never,
                    {
                        commit: async () => {
                            currentSettings = stagedSettings;
                            currentAgents = stagedAgents;
                            currentAutoFollowup = stagedAutoFollowup;
                            currentAutoResolveMergeConflicts = stagedAutoResolve;
                            currentPrReviewModel = stagedPrReviewModel;
                            currentUltrafixRatingGoal = stagedUltrafixGoal;
                            currentUltrafixMaxCycles = stagedUltrafixCycles;
                            currentUltrafixPauseSeconds = stagedUltrafixPause;
                        },
                        rollback: async () => {},
                    },
                );
                return trx;
            },
        };
    }

    beforeEach(() => {
        currentSettings = { default_agent_alias: 'old-default', worker_concurrency: 5, keep: 'unchanged' };
        currentAgents = [
            {
                id: 'old-agent',
                alias: 'old-default',
                type: 'claude',
                enabled: true,
                dockerImage: 'old:image',
                configPath: '/tmp/claude',
                supportedModels: [],
            },
        ];
        currentAutoFollowup = 4;
        currentAutoResolveMergeConflicts = false;
        currentPrReviewModel = '';
        currentUltrafixRatingGoal = 7;
        currentUltrafixMaxCycles = 5;
        currentUltrafixPauseSeconds = 60;
        failAutoFollowupSave = false;
        configWriteFailure = null;
    });

    test('resolveConfigStore preserves the production namespace when no overrides are injected', () => {
        assert.strictEqual(resolveConfigStore(), configManager);
        assert.notStrictEqual(resolveConfigStore({}), configManager);
    });

    test('applyAgentsUpdate reapplies the new default alias to the live registry', async () => {
        const registry = {
            refresh: mock.fn(async () => {}),
            setDefaultAgentAlias: mock.fn((_alias: string | null) => {}),
        };
        const configStore = {
            loadAgents: async () => currentAgents as never[],
            loadSettings: async () => currentSettings,
            handleSettingsSaveSideEffects: () => {},
            saveAgents: async (agents: never[]) => {
                currentAgents = agents as Array<Record<string, unknown>>;
                return true;
            },
            saveSettings: async (settings: Record<string, unknown>) => {
                currentSettings = { ...currentSettings, ...settings };
                return true;
            },
        };
        const result = await applyAgentsUpdate({
            agents: [
                {
                    id: 'new-agent',
                    alias: 'new-default',
                    type: 'claude',
                    enabled: true,
                    dockerImage: 'new:image',
                    configPath: '/tmp/claude',
                    supportedModels: [],
                },
            ],
            username: 'alice',
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            configStore,
            database: createTestDatabase(),
            registry,
        });

        assert.strictEqual(result.status, 200);
        assert.strictEqual(currentSettings.default_agent_alias, 'new-default');
        assert.strictEqual(registry.refresh.mock.calls.length, 1);
        assert.strictEqual(registry.setDefaultAgentAlias.mock.calls.length, 1);
        assert.strictEqual(registry.setDefaultAgentAlias.mock.calls[0].arguments[0], 'new-default');
    });

    test('saveSettingsWithRollback restores earlier writes when a later save fails', async () => {
        const published: string[] = [];
        const configStore = {
            saveSettings: async (settings: Record<string, unknown>) => {
                currentSettings = { ...currentSettings, ...settings };
                return true;
            },
            saveConfig: async (key: string, value: unknown) => {
                if (key === 'settings') {
                    currentSettings = value as Record<string, unknown>;
                }
                return true;
            },
            handleSettingsSaveSideEffects: () => {},
            loadSettings: async () => ({ ...currentSettings }),
            loadAutoFollowupScoreThreshold: async () => currentAutoFollowup,
            saveAutoFollowupScoreThreshold: async (value: number) => {
                if (failAutoFollowupSave) {
                    throw new Error('save failed');
                }
                currentAutoFollowup = value;
                return true;
            },
            loadAutoResolveMergeConflicts: async () => currentAutoResolveMergeConflicts,
            saveAutoResolveMergeConflicts: async (value: boolean) => {
                currentAutoResolveMergeConflicts = value;
                return true;
            },
            loadPrReviewModel: async () => currentPrReviewModel,
            savePrReviewModel: async (value: string) => {
                currentPrReviewModel = value;
                return true;
            },
            loadUltrafixRatingGoal: async () => currentUltrafixRatingGoal,
            saveUltrafixRatingGoal: async (value: number) => {
                currentUltrafixRatingGoal = value;
                return true;
            },
            loadUltrafixMaxCycles: async () => currentUltrafixMaxCycles,
            saveUltrafixMaxCycles: async (value: number) => {
                currentUltrafixMaxCycles = value;
                return true;
            },
            loadUltrafixPauseSeconds: async () => currentUltrafixPauseSeconds,
            saveUltrafixPauseSeconds: async (value: number) => {
                currentUltrafixPauseSeconds = value;
                return true;
            },
        };

        failAutoFollowupSave = true;
        configWriteFailure = key => key === 'auto_followup_score_threshold' && failAutoFollowupSave
            ? new Error('save failed')
            : null;

        const result = await saveSettingsWithRollback({
            settings: {
                worker_concurrency: 9,
                keep: 'updated',
                auto_followup_score_threshold: 6,
            },
            publishConfigUpdate: async (subtype: string) => {
                published.push(subtype);
            },
            configStore,
            database: createTestDatabase(),
        });

        assert.strictEqual(result.status, 500);
        assert.deepStrictEqual(currentSettings, {
            default_agent_alias: 'old-default',
            worker_concurrency: 5,
            keep: 'unchanged',
        });
        assert.deepStrictEqual(result.body, {
            error: 'Failed to save "auto_followup_score_threshold". No settings were committed. Please retry or check system logs.',
        });
        assert.deepStrictEqual(published, []);
    });

    test('saveSettingsWithRollback accepts mixed general and ultrafix settings payloads', async () => {
        const configStore = {
            saveSettings: async (settings: Record<string, unknown>) => {
                currentSettings = { ...currentSettings, ...settings };
                return true;
            },
            saveConfig: async (_key: string, _value: unknown) => true,
            handleSettingsSaveSideEffects: () => {},
            loadSettings: async () => ({ ...currentSettings }),
            loadAutoFollowupScoreThreshold: async () => currentAutoFollowup,
            saveAutoFollowupScoreThreshold: async (value: number) => {
                currentAutoFollowup = value;
                return true;
            },
            loadAutoResolveMergeConflicts: async () => currentAutoResolveMergeConflicts,
            saveAutoResolveMergeConflicts: async (value: boolean) => {
                currentAutoResolveMergeConflicts = value;
                return true;
            },
            loadPrReviewModel: async () => currentPrReviewModel,
            savePrReviewModel: async (value: string) => {
                currentPrReviewModel = value;
                return true;
            },
            loadUltrafixRatingGoal: async () => currentUltrafixRatingGoal,
            saveUltrafixRatingGoal: async (value: number) => {
                currentUltrafixRatingGoal = value;
                return true;
            },
            loadUltrafixMaxCycles: async () => currentUltrafixMaxCycles,
            saveUltrafixMaxCycles: async (value: number) => {
                currentUltrafixMaxCycles = value;
                return true;
            },
            loadUltrafixPauseSeconds: async () => currentUltrafixPauseSeconds,
            saveUltrafixPauseSeconds: async (value: number) => {
                currentUltrafixPauseSeconds = value;
                return true;
            },
        };

        const result = await saveSettingsWithRollback({
            settings: {
                worker_concurrency: 11,
                planner_generation_model: 'gpt-test',
                ultrafix_rating_goal: '8',
                ultrafix_pause_seconds: 0,
            },
            publishConfigUpdate: async () => {},
            configStore,
            database: createTestDatabase(),
        });

        assert.strictEqual(result.status, 200);
        assert.deepStrictEqual(currentSettings, {
            default_agent_alias: 'old-default',
            worker_concurrency: 11,
            keep: 'unchanged',
            planner_generation_model: 'gpt-test',
        });
        assert.strictEqual(currentUltrafixRatingGoal, 8);
        assert.strictEqual(currentUltrafixPauseSeconds, 0);
        assert.deepStrictEqual(result.body, {
            success: true,
            settings: {
                worker_concurrency: 11,
                planner_generation_model: 'gpt-test',
                ultrafix_rating_goal: 8,
                ultrafix_pause_seconds: 0,
            },
        });
    });

    test('withConfigLock stops protected work after lock loss is detected', async () => {
        const redisState = new Map<string, string>();
        const redisClient = {
            set: mock.fn(async (key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
                if (opts.NX && redisState.has(key)) return null;
                redisState.set(key, value);
                return 'OK';
            }),
            del: mock.fn(async (key: string) => {
                redisState.delete(key);
                return 1;
            }),
            eval: mock.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
                const [key] = options.keys;
                const [lockValue, timeoutSeconds] = options.arguments;
                if (timeoutSeconds === undefined) {
                    if (redisState.get(key) === lockValue) {
                        redisState.delete(key);
                        return 1;
                    }
                    return 0;
                }
                return redisState.get(key) === lockValue ? 1 : 0;
            }),
        };

        const writes: string[] = [];
        const result = await withConfigLock(
            redisClient as never,
            'config:test:lock',
            async lock => {
                await lock.assertLockHeld();
                writes.push('before-loss');
                redisState.set('config:test:lock', 'someone-else');
                await assert.rejects(() => lock.assertLockHeld(), /ownership lost/);
                return { status: 200, body: { success: true } };
            },
        );

        assert.deepStrictEqual(writes, ['before-loss']);
        assert.strictEqual(result.status, 409);
        assert.deepStrictEqual(result.body, {
            error: 'Configuration update lock was lost before the operation completed. Verify the current configuration before retrying.',
            lock_lost: true,
        });
        assert.strictEqual(redisState.get('config:test:lock'), 'someone-else');
    });

    test('withConfigLock fails closed when atomic renew scripting is unavailable', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
            get: mock.fn(async () => 'lock-owner'),
            del: mock.fn(async () => 1),
        };

        const result = await withConfigLock(
            redisClient as never,
            'config:test:lock',
            async lock => {
                await assert.rejects(() => lock.assertLockHeld(), /renewal failed/);
                return { status: 200, body: { success: true } };
            },
        );

        assert.strictEqual(result.status, 409);
        assert.deepStrictEqual(result.body, {
            error: 'Configuration update lock renewal failed before the operation completed. Verify the current configuration before retrying.',
            lock_lost: true,
        });
    });

    test('applyAgentsUpdate reports out-of-sync state when registry refresh and rollback both fail', async () => {
        const registry = {
            refresh: mock.fn(async () => {
                throw new Error('refresh failed');
            }),
            setDefaultAgentAlias: mock.fn((_alias: string | null) => {}),
        };
        const configStore = {
            loadAgents: async () => currentAgents as never[],
            loadSettings: async () => currentSettings,
            handleSettingsSaveSideEffects: () => {},
            saveAgents: mock.fn(async (agents: never[]) => {
                currentAgents = agents as Array<Record<string, unknown>>;
                if ((agents as Array<Record<string, unknown>>)[0]?.alias === 'old-default') {
                    throw new Error('rollback save failed');
                }
                return true;
            }),
            saveSettings: async (settings: Record<string, unknown>) => {
                currentSettings = { ...currentSettings, ...settings };
                return true;
            },
        };
        configWriteFailure = (key, value) => key === 'agents'
            && (value as Array<Record<string, unknown>>)[0]?.alias === 'old-default'
            ? new Error('rollback save failed')
            : null;

        const result = await applyAgentsUpdate({
            agents: [
                {
                    id: 'new-agent',
                    alias: 'new-default',
                    type: 'claude',
                    enabled: true,
                    dockerImage: 'new:image',
                    configPath: '/tmp/claude',
                    supportedModels: [],
                },
            ],
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            configStore,
            database: createTestDatabase(),
            registry,
        });

        assert.strictEqual(result.status, 500);
        assert.deepStrictEqual(result.body, {
            error: 'Failed to apply committed agent configuration to the live registry, and automatic rollback did not complete. Persisted config may be out of sync with the live registry.',
            out_of_sync: true,
        });
    });

    test('applyAgentsUpdate leaves no partial state when the atomic settings write fails', async () => {
        const registry = {
            refresh: mock.fn(async () => {}),
            setDefaultAgentAlias: mock.fn((_alias: string | null) => {}),
        };
        let saveSettingsCalls = 0;
        const configStore = {
            loadAgents: async () => currentAgents as never[],
            loadSettings: async () => currentSettings,
            handleSettingsSaveSideEffects: () => {},
            saveAgents: async (agents: never[]) => {
                currentAgents = agents as Array<Record<string, unknown>>;
                return true;
            },
            saveSettings: async (settings: Record<string, unknown>) => {
                saveSettingsCalls += 1;
                if (saveSettingsCalls === 1) {
                    currentSettings = { ...currentSettings, ...settings };
                    throw new Error('settings save failed');
                }
                currentSettings = { ...currentSettings, ...settings };
                return true;
            },
        };

        configWriteFailure = key => key === 'settings' ? new Error('settings save failed') : null;
        const result = await applyAgentsUpdate({
            agents: [
                {
                    id: 'new-agent',
                    alias: 'new-default',
                    type: 'claude',
                    enabled: true,
                    dockerImage: 'new:image',
                    configPath: '/tmp/claude',
                    supportedModels: [],
                },
            ],
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            configStore,
            database: createTestDatabase(),
            registry,
        });

        assert.strictEqual(result.status, 500);
        assert.deepStrictEqual(result.body, {
            error: 'Failed to persist agent configuration. No changes were committed. Please retry or check system logs.',
        });
        assert.deepStrictEqual(currentAgents, [
            {
                id: 'old-agent',
                alias: 'old-default',
                type: 'claude',
                enabled: true,
                dockerImage: 'old:image',
                configPath: '/tmp/claude',
                supportedModels: [],
            },
        ]);
        assert.strictEqual(currentSettings.default_agent_alias, 'old-default');
    });

    test('applyAgentsUpdate rolls persisted config back when registry refresh fails', async () => {
        let refreshCalls = 0;
        const registry = {
            refresh: mock.fn(async () => {
                refreshCalls += 1;
                if (refreshCalls === 1) {
                    throw new Error('refresh failed');
                }
            }),
            setDefaultAgentAlias: mock.fn((_alias: string | null) => {}),
        };
        const configStore = {
            loadAgents: async () => currentAgents as never[],
            loadSettings: async () => currentSettings,
            handleSettingsSaveSideEffects: () => {},
            saveAgents: async (agents: never[]) => {
                currentAgents = agents as Array<Record<string, unknown>>;
                return true;
            },
            saveSettings: async (settings: Record<string, unknown>) => {
                currentSettings = { ...currentSettings, ...settings };
                return true;
            },
        };

        const result = await applyAgentsUpdate({
            agents: [
                {
                    id: 'new-agent',
                    alias: 'new-default',
                    type: 'claude',
                    enabled: true,
                    dockerImage: 'new:image',
                    configPath: '/tmp/claude',
                    supportedModels: [],
                },
            ],
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            configStore,
            database: createTestDatabase(),
            registry,
        });

        assert.strictEqual(result.status, 500);
        assert.deepStrictEqual(currentAgents, [
            {
                id: 'old-agent',
                alias: 'old-default',
                type: 'claude',
                enabled: true,
                dockerImage: 'old:image',
                configPath: '/tmp/claude',
                supportedModels: [],
            },
        ]);
        assert.strictEqual(currentSettings.default_agent_alias, 'old-default');
        assert.strictEqual(registry.refresh.mock.calls.length, 2);
        assert.strictEqual(registry.setDefaultAgentAlias.mock.calls[0].arguments[0], 'old-default');
    });

    test('applyAgentsUpdate awaits async side effect failures before reporting rollback status', async () => {
        let sideEffectCalls = 0;
        const registry = {
            refresh: mock.fn(async () => {}),
            setDefaultAgentAlias: mock.fn((_alias: string | null) => {}),
        };
        const configStore = {
            loadAgents: async () => currentAgents as never[],
            loadSettings: async () => currentSettings,
            handleSettingsSaveSideEffects: async () => {
                sideEffectCalls += 1;
                if (sideEffectCalls === 1) {
                    throw new Error('async side effect failed');
                }
            },
        };

        const result = await applyAgentsUpdate({
            agents: [
                {
                    id: 'new-agent',
                    alias: 'new-default',
                    type: 'claude',
                    enabled: true,
                    dockerImage: 'new:image',
                    configPath: '/tmp/claude',
                    supportedModels: [],
                },
            ],
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            configStore,
            database: createTestDatabase(),
            registry,
        });

        assert.strictEqual(result.status, 500);
        assert.deepStrictEqual(result.body, {
            error: 'Failed to apply agent configuration to the live registry',
        });
        assert.strictEqual(sideEffectCalls, 2);
        assert.deepStrictEqual(currentAgents, [
            {
                id: 'old-agent',
                alias: 'old-default',
                type: 'claude',
                enabled: true,
                dockerImage: 'old:image',
                configPath: '/tmp/claude',
                supportedModels: [],
            },
        ]);
        assert.strictEqual(currentSettings.default_agent_alias, 'old-default');
    });

    test('applyAgentsUpdate treats async rollback side effect failures as rollback failures', async () => {
        const registry = {
            refresh: mock.fn(async () => {
                throw new Error('refresh failed');
            }),
            setDefaultAgentAlias: mock.fn((_alias: string | null) => {}),
        };
        const configStore = {
            loadAgents: async () => currentAgents as never[],
            loadSettings: async () => currentSettings,
            handleSettingsSaveSideEffects: async () => {
                throw new Error('async rollback side effect failed');
            },
        };

        const result = await applyAgentsUpdate({
            agents: [
                {
                    id: 'new-agent',
                    alias: 'new-default',
                    type: 'claude',
                    enabled: true,
                    dockerImage: 'new:image',
                    configPath: '/tmp/claude',
                    supportedModels: [],
                },
            ],
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            configStore,
            database: createTestDatabase(),
            registry,
        });

        assert.strictEqual(result.status, 500);
        assert.deepStrictEqual(result.body, {
            error: 'Failed to apply committed agent configuration to the live registry, and automatic rollback did not complete. Persisted config may be out of sync with the live registry.',
            out_of_sync: true,
        });
    });

    test('saveSettingsWithRollback rejects array payloads', async () => {
        const result = await saveSettingsWithRollback({
            settings: [] as unknown as Record<string, unknown>,
            publishConfigUpdate: async () => {},
        });

        assert.strictEqual(result.status, 400);
        assert.deepStrictEqual(result.body, {
            error: 'settings object is required',
        });
    });

    test('postAgents rejects invalid payloads before acquiring the shared settings lock', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
        };
        const routes = createAgentsRoutes({
            redisClient: redisClient as never,
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postAgents({ body: { agents: 'bad-payload' } } as never, res as never);

        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(res.body, { error: 'agents must be an array' });
        assert.strictEqual(redisClient.set.mock.calls.length, 0);
    });

    test('postAgents rejects requests with a missing agents array before acquiring the shared settings lock', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
        };
        const routes = createAgentsRoutes({
            redisClient: redisClient as never,
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postAgents({ body: {} } as never, res as never);

        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(res.body, { error: 'agents must be an array' });
        assert.strictEqual(redisClient.set.mock.calls.length, 0);
    });

    test('postAgents rejects null agent entries with a 400 before acquiring the shared settings lock', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
        };
        const routes = createAgentsRoutes({
            redisClient: redisClient as never,
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postAgents({ body: { agents: [null] } } as never, res as never);

        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(res.body, { error: 'Each agent must be an object' });
        assert.strictEqual(redisClient.set.mock.calls.length, 0);
    });

    test('postAgents rejects agents with missing or non-string aliases with a 400 before acquiring the shared settings lock', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
        };
        const routes = createAgentsRoutes({
            redisClient: redisClient as never,
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postAgents({
            body: {
                agents: [
                    {
                        id: 'broken-agent',
                        type: 'claude',
                        enabled: true,
                        configPath: '/tmp/claude',
                        supportedModels: [],
                    },
                ],
            },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(res.body, { error: "Agent 'broken-agent' missing required 'alias' field" });
        assert.strictEqual(redisClient.set.mock.calls.length, 0);

        await routes.postAgents({
            body: {
                agents: [
                    {
                        id: 'broken-agent',
                        alias: 123,
                        type: 'claude',
                        enabled: true,
                        configPath: '/tmp/claude',
                        supportedModels: [],
                    },
                ],
            },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(res.body, { error: "Agent 'broken-agent' missing required 'alias' field" });
        assert.strictEqual(redisClient.set.mock.calls.length, 0);
    });

    test('postAgents resolves agent versions before acquiring the shared settings lock', async () => {
        let lockAcquired = false;
        const redisClient = {
            set: mock.fn(async () => {
                lockAcquired = true;
                return 'OK';
            }),
            eval: mock.fn(async () => 1),
        };
        const resolveVersionMock = mock.fn(async () => {
            assert.strictEqual(lockAcquired, false);
            return '1.2.3';
        });

        const routes = createAgentsRoutes({
            redisClient: redisClient as never,
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            preparationDeps: { resolveVersion: resolveVersionMock },
            applyAgentsUpdateFn: async params => ({
                status: 200,
                body: { success: true, agents: params.processedAgents ?? params.agents },
            }),
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postAgents({
            body: {
                agents: [
                    {
                        id: 'new-agent',
                        alias: 'new-default',
                        type: 'claude',
                        enabled: true,
                        dockerImage: 'new:image',
                        configPath: '/tmp/claude',
                        supportedModels: [],
                        cliVersionType: 'default',
                    },
                ],
            },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(resolveVersionMock.mock.calls.length, 1);
    });

    test('postAgents reports transient version resolution failures as server errors', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
        };
        const resolveVersionMock = mock.fn(async () => {
            throw new Error('network timeout');
        });

        const routes = createAgentsRoutes({
            redisClient: redisClient as never,
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            preparationDeps: { resolveVersion: resolveVersionMock },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postAgents({
            body: {
                agents: [
                    {
                        id: 'new-agent',
                        alias: 'new-default',
                        type: 'claude',
                        enabled: true,
                        dockerImage: 'new:image',
                        configPath: '/tmp/claude',
                        supportedModels: [],
                        cliVersionType: 'default',
                    },
                ],
            },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 502);
        assert.deepStrictEqual(res.body, {
            code: 'AGENT_VERSION_LOOKUP_UNAVAILABLE',
            error: "Failed to resolve version for agent 'new-default': Agent version lookup is temporarily unavailable",
        });
        assert.strictEqual(redisClient.set.mock.calls.length, 0);
        assert.strictEqual(resolveVersionMock.mock.calls.length, 1);
    });

    test('prepareAgentsUpdate does not resolve versions for disabled agents', async () => {
        const resolveVersionMock = mock.fn(async () => {
            throw new Error('registry unavailable');
        });
        const result = await prepareAgentsUpdate([
            {
                id: 'disabled-agent',
                alias: 'disabled-custom',
                type: 'claude',
                enabled: false,
                dockerImage: 'old:image',
                configPath: '/tmp/claude-disabled',
                supportedModels: [],
                cliVersionType: 'custom',
                cliVersion: 'github:example/claude-fork',
                cliVersionResolved: 'github:example/claude-fork#resolved',
            },
        ], {
            resolveVersion: resolveVersionMock,
            computeContentHash: () => 'content-hash',
            generateAgentBundleImageTag: () => 'propr/agent:test',
        });

        assert.strictEqual(result.error, undefined);
        assert.strictEqual(resolveVersionMock.mock.calls.length, 0);
        assert.strictEqual(result.processedAgents?.[0].cliVersionResolved, 'github:example/claude-fork#resolved');
    });

    test('prepareAgentsUpdate does not mislabel local TypeErrors as registry outages', async () => {
        const result = await prepareAgentsUpdate([
            {
                id: 'new-agent',
                alias: 'new-default',
                type: 'claude',
                enabled: true,
                dockerImage: 'new:image',
                configPath: '/tmp/claude',
                supportedModels: [],
                cliVersionType: 'default',
            },
        ], {
            resolveVersion: async () => {
                throw new TypeError('Cannot read properties of undefined');
            },
            computeContentHash: () => 'content-hash',
            generateAgentBundleImageTag: () => 'propr/agent:test',
        });

        assert.strictEqual(result.status, 500);
        assert.deepStrictEqual(result.error, "Failed to resolve version for agent 'new-default': Agent version resolution failed");
    });

    test('postAgents reports internal agent image derivation failures as server errors', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
        };
        const computeContentHashMock = mock.fn(() => {
            throw new Error('hash generation failed');
        });

        const routes = createAgentsRoutes({
            redisClient: redisClient as never,
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            preparationDeps: { computeContentHash: computeContentHashMock },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postAgents({
            body: {
                agents: [
                    {
                        id: 'new-agent',
                        alias: 'new-default',
                        type: 'claude',
                        enabled: true,
                        configPath: '/tmp/claude',
                        supportedModels: [],
                        cliVersionType: 'default',
                    },
                ],
            },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 500);
        assert.deepStrictEqual(res.body, {
            error: 'Failed to derive managed agent image',
        });
        assert.strictEqual(redisClient.set.mock.calls.length, 0);
    });

    test('postAgents rejects malformed cliVersion fields before version resolution or lock acquisition', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
        };
        const resolveVersionMock = mock.fn(async () => '1.2.3');
        const routes = createAgentsRoutes({
            redisClient: redisClient as never,
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            preparationDeps: { resolveVersion: resolveVersionMock },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postAgents({
            body: {
                agents: [
                    {
                        id: 'new-agent',
                        alias: 'new-default',
                        type: 'claude',
                        enabled: true,
                        dockerImage: 'new:image',
                        configPath: '/tmp/claude',
                        supportedModels: [],
                        cliVersionType: 'broken',
                        cliVersion: 'latest',
                    },
                ],
            },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(res.body, {
            error: "Agent 'new-agent' has invalid cliVersionType 'broken'. Must be one of: default, tag, specific, custom",
        });
        assert.strictEqual(redisClient.set.mock.calls.length, 0);
        assert.strictEqual(resolveVersionMock.mock.calls.length, 0);
    });

    test('getSettings preserves legacy string-backed integer settings', async () => {
        const autoFollowupMock = mock.fn(async () => '7' as never);
        const autoResolveMock = mock.fn(async () => false);
        const prReviewModelMock = mock.fn(async () => '');
        const ultrafixGoalMock = mock.fn(async () => '8' as never);
        const ultrafixCyclesMock = mock.fn(async () => '9' as never);
        const ultrafixPauseMock = mock.fn(async () => '12' as never);
        const settingsMock = mock.fn(async () => ({}));
        const routes = createConfigRoutes({
            redisClient: {} as never,
            configStore: {
                loadSettings: settingsMock,
                loadModelReasoningLevel: async () => '',
                loadAutoFollowupScoreThreshold: autoFollowupMock,
                loadAutoResolveMergeConflicts: autoResolveMock,
                loadPrReviewModel: prReviewModelMock,
                loadUltrafixRatingGoal: ultrafixGoalMock,
                loadUltrafixMaxCycles: ultrafixCyclesMock,
                loadUltrafixPauseSeconds: ultrafixPauseMock,
            },
        });
        const res = {
            body: undefined as Record<string, unknown> | undefined,
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
            status(_code: number) {
                return this;
            },
        };

        await routes.getSettings({} as never, res as never);

        assert.deepStrictEqual(res.body, {
            default_agent_alias: undefined,
            worker_concurrency: 5,
            github_user_whitelist: [],
            analysis_model_fast: '',
            planner_context_model: '',
            planner_generation_model: '',
            pr_review_prompt: '',
            auto_followup_score_threshold: 7,
            auto_resolve_merge_conflicts: false,
            model_reasoning_level: '',
            pr_review_model: '',
            ultrafix_rating_goal: 8,
            ultrafix_max_cycles: 9,
            ultrafix_pause_seconds: 12,
        });
        assert.strictEqual(settingsMock.mock.calls.length, 1);
        assert.strictEqual(autoFollowupMock.mock.calls.length, 1);
        assert.strictEqual(autoResolveMock.mock.calls.length, 1);
        assert.strictEqual(prReviewModelMock.mock.calls.length, 1);
        assert.strictEqual(ultrafixGoalMock.mock.calls.length, 1);
        assert.strictEqual(ultrafixCyclesMock.mock.calls.length, 1);
        assert.strictEqual(ultrafixPauseMock.mock.calls.length, 1);
    });

    test('getSettings returns a persisted default agent alias', async () => {
        const autoFollowupMock = mock.fn(async () => 4);
        const autoResolveMock = mock.fn(async () => true);
        const prReviewModelMock = mock.fn(async () => 'review-model');
        const ultrafixGoalMock = mock.fn(async () => 8);
        const ultrafixCyclesMock = mock.fn(async () => 9);
        const ultrafixPauseMock = mock.fn(async () => 12);
        const settingsMock = mock.fn(async () => ({
            default_agent_alias: 'claude',
            worker_concurrency: 6,
            github_user_whitelist: ['alice'],
            analysis_model_fast: 'fast-model',
            planner_context_model: 'context-model',
            planner_generation_model: 'generation-model',
        }));
        const routes = createConfigRoutes({
            redisClient: {} as never,
            configStore: {
                loadSettings: settingsMock,
                loadModelReasoningLevel: async () => '',
                loadAutoFollowupScoreThreshold: autoFollowupMock,
                loadAutoResolveMergeConflicts: autoResolveMock,
                loadPrReviewModel: prReviewModelMock,
                loadUltrafixRatingGoal: ultrafixGoalMock,
                loadUltrafixMaxCycles: ultrafixCyclesMock,
                loadUltrafixPauseSeconds: ultrafixPauseMock,
            },
        });
        const res = {
            body: undefined as Record<string, unknown> | undefined,
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
            status(_code: number) {
                return this;
            },
        };

        await routes.getSettings({} as never, res as never);

        assert.deepStrictEqual(res.body, {
            default_agent_alias: 'claude',
            worker_concurrency: 6,
            github_user_whitelist: ['alice'],
            analysis_model_fast: 'fast-model',
            planner_context_model: 'context-model',
            planner_generation_model: 'generation-model',
            pr_review_prompt: '',
            auto_followup_score_threshold: 4,
            auto_resolve_merge_conflicts: true,
            model_reasoning_level: '',
            pr_review_model: 'review-model',
            ultrafix_rating_goal: 8,
            ultrafix_max_cycles: 9,
            ultrafix_pause_seconds: 12,
        });
        assert.strictEqual(settingsMock.mock.calls.length, 1);
        assert.strictEqual(autoFollowupMock.mock.calls.length, 1);
        assert.strictEqual(autoResolveMock.mock.calls.length, 1);
        assert.strictEqual(prReviewModelMock.mock.calls.length, 1);
        assert.strictEqual(ultrafixGoalMock.mock.calls.length, 1);
        assert.strictEqual(ultrafixCyclesMock.mock.calls.length, 1);
        assert.strictEqual(ultrafixPauseMock.mock.calls.length, 1);
    });

    test('getSettings falls back to defaults when persisted integer-backed settings are invalid', async () => {
        const autoFollowupMock = mock.fn(async () => 'invalid' as never);
        const autoResolveMock = mock.fn(async () => false);
        const prReviewModelMock = mock.fn(async () => '');
        const ultrafixGoalMock = mock.fn(async () => 8);
        const ultrafixCyclesMock = mock.fn(async () => 9);
        const ultrafixPauseMock = mock.fn(async () => 12);
        const settingsMock = mock.fn(async () => ({}));
        const routes = createConfigRoutes({
            redisClient: {} as never,
            configStore: {
                loadSettings: settingsMock,
                loadModelReasoningLevel: async () => '',
                loadAutoFollowupScoreThreshold: autoFollowupMock,
                loadAutoResolveMergeConflicts: autoResolveMock,
                loadPrReviewModel: prReviewModelMock,
                loadUltrafixRatingGoal: ultrafixGoalMock,
                loadUltrafixMaxCycles: ultrafixCyclesMock,
                loadUltrafixPauseSeconds: ultrafixPauseMock,
            },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
            status(code: number) {
                this.statusCode = code;
                return this;
            },
        };

        await routes.getSettings({} as never, res as never);

        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, {
            default_agent_alias: undefined,
            worker_concurrency: 5,
            github_user_whitelist: [],
            analysis_model_fast: '',
            planner_context_model: '',
            planner_generation_model: '',
            pr_review_prompt: '',
            auto_followup_score_threshold: 4,
            auto_resolve_merge_conflicts: false,
            model_reasoning_level: '',
            pr_review_model: '',
            ultrafix_rating_goal: 8,
            ultrafix_max_cycles: 9,
            ultrafix_pause_seconds: 12,
            invalid_settings: {
                auto_followup_score_threshold: 'invalid',
            },
        });
        assert.strictEqual(settingsMock.mock.calls.length, 1);
        assert.strictEqual(autoFollowupMock.mock.calls.length, 1);
        assert.strictEqual(autoResolveMock.mock.calls.length, 1);
        assert.strictEqual(prReviewModelMock.mock.calls.length, 1);
        assert.strictEqual(ultrafixGoalMock.mock.calls.length, 1);
        assert.strictEqual(ultrafixCyclesMock.mock.calls.length, 1);
        assert.strictEqual(ultrafixPauseMock.mock.calls.length, 1);
    });

    test('applyAgentsUpdate replaces a submitted dockerImage with the managed bundle image', async () => {
        const registry = {
            refresh: mock.fn(async () => {}),
            setDefaultAgentAlias: mock.fn((_alias: string | null) => {}),
        };

        const result = await applyAgentsUpdate({
            agents: [
                {
                    id: 'new-agent',
                    alias: 'new-default',
                    type: 'claude',
                    enabled: true,
                    dockerImage: 'private.registry/propr/custom:1.2.3',
                    configPath: '/tmp/claude',
                    supportedModels: [],
                },
            ],
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            configStore: {
                loadAgents: async () => currentAgents as never[],
                loadSettings: async () => currentSettings,
                handleSettingsSaveSideEffects: () => {},
            },
            database: createTestDatabase(),
            registry,
        });

        assert.strictEqual(result.status, 200);
        assert.match(String((result.body.agents as Array<Record<string, unknown>>)[0]?.dockerImage), /^propr\/agent:bundle-[0-9a-f]{12}-[0-9a-f]{6}$/);
    });

    test('normalizeAgentsConfig trims supportedModels entries', () => {
        const normalized = normalizeAgentsConfig([
            {
                id: 'agent-1',
                alias: ' agent-1 ',
                type: 'claude',
                enabled: true,
                dockerImage: 'claude:image',
                configPath: '/tmp/claude',
                supportedModels: [' claude-sonnet-4-6 ', 'claude-opus-4-6'],
                cliVersionType: 'default',
                cliVersion: 'latest',
            },
        ] as never);

        assert.deepStrictEqual(normalized[0]?.supportedModels, ['claude-sonnet-4-6', 'claude-opus-4-6']);
        assert.strictEqual(normalized[0]?.alias, 'agent-1');
        assert.strictEqual(normalized[0]?.cliVersion, undefined);
    });

    test('applyAgentsUpdate accepts agents without dockerImage and derives it server-side', async () => {
        const contentHashMock = mock.fn(() => 'abc123');
        const registry = {
            refresh: mock.fn(async () => {}),
            setDefaultAgentAlias: mock.fn((_alias: string | null) => {}),
        };

        const result = await applyAgentsUpdate({
            agents: [
                {
                    id: 'new-agent',
                    alias: 'new-default',
                    type: 'claude',
                    enabled: true,
                    configPath: '/tmp/claude',
                    supportedModels: [],
                },
            ],
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
            configStore: {
                loadAgents: async () => currentAgents as never[],
                loadSettings: async () => currentSettings,
                handleSettingsSaveSideEffects: () => {},
            },
            database: createTestDatabase(),
            preparationDeps: { computeContentHash: contentHashMock },
            registry,
        });

        assert.strictEqual(result.status, 200);
        assert.strictEqual(typeof (result.body.agents as Array<Record<string, unknown>>)[0]?.dockerImage, 'string');
        assert.match(String((result.body.agents as Array<Record<string, unknown>>)[0]?.dockerImage), /^propr\/agent:bundle-[0-9a-f]{12}-abc123$/);
        contentHashMock.mock.restore();
    });

    test('findLatestHistoryEntryWithSessionId returns the latest live execution session entry', () => {
        const entry = findLatestHistoryEntryWithSessionId([
            { state: 'claude_execution', metadata: { sessionId: 'older-session' } },
            { state: 'processing', metadata: {} },
            { state: 'codex_execution', metadata: { sessionId: 'codex-session' } },
        ]);

        assert.deepStrictEqual(entry, {
            state: 'codex_execution',
            metadata: { sessionId: 'codex-session' },
        });
    });

    test('findLatestHistoryEntryWithSessionId ignores non-execution states with session metadata', () => {
        const entry = findLatestHistoryEntryWithSessionId([
            { state: 'claude_execution', metadata: { sessionId: 'live-session' } },
            { state: 'post_processing', metadata: { sessionId: 'stale-session' } },
            { state: 'completed', metadata: { sessionId: 'completed-session' } },
        ]);

        assert.deepStrictEqual(entry, {
            state: 'claude_execution',
            metadata: { sessionId: 'live-session' },
        });
    });

    test('withConfigLock renews the lock while a long operation is running', async () => {
        const redisState = new Map<string, string>();
        const redisClient = {
            set: mock.fn(async (key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
                if (opts.NX && redisState.has(key)) return null;
                redisState.set(key, value);
                return 'OK';
            }),
            del: mock.fn(async (key: string) => {
                redisState.delete(key);
                return 1;
            }),
            eval: mock.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
                const [key] = options.keys;
                const [lockValue, timeoutSeconds] = options.arguments;
                if (timeoutSeconds === undefined) {
                    if (redisState.get(key) === lockValue) {
                        redisState.delete(key);
                        return 1;
                    }
                    return 0;
                }
                if (redisState.get(key) !== lockValue) {
                    return 0;
                }
                return 1;
            }),
        };

        const result = await withConfigLock(
            redisClient as never,
            'config:test:lock',
            async () => {
                await new Promise(resolve => setTimeout(resolve, 35));
                return { status: 200, body: { success: true } };
            },
            { timeoutSeconds: 1, renewalIntervalMs: 10 },
        );

        assert.strictEqual(result.status, 200);
        assert.ok(redisClient.eval.mock.calls.length >= 2);
        assert.strictEqual(redisState.has('config:test:lock'), false);
    });

    test('withConfigLock preserves a successful result when lock release fails', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
            eval: mock.fn(async (_script: string, options: { arguments: string[] }) => {
                if (options.arguments.length === 1) {
                    throw new Error('unlock failed');
                }
                return 1;
            }),
        };

        const result = await withConfigLock(
            redisClient as never,
            'config:test:lock',
            async () => ({ status: 200, body: { success: true } }),
        );

        assert.strictEqual(result.status, 200);
        assert.deepStrictEqual(result.body, { success: true });
    });

    test('withConfigLock does not delete a lock that has been replaced by another owner in the transaction fallback', async () => {
        const redisState = new Map<string, string>();
        let watchedKey: string | null = null;
        const redisClient = {
            set: mock.fn(async (key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
                if (opts.NX && redisState.has(key)) return null;
                redisState.set(key, value);
                return 'OK';
            }),
            get: mock.fn(async (key: string) => redisState.get(key) ?? null),
            watch: mock.fn(async (key: string) => {
                watchedKey = key;
            }),
            unwatch: mock.fn(async () => {
                watchedKey = null;
            }),
            multi: mock.fn(() => ({
                del(key: string) {
                    return {
                        exec: async () => {
                            if (watchedKey !== key || redisState.get(key) !== 'someone-else') {
                                return null;
                            }
                            redisState.delete(key);
                            return [1];
                        },
                    };
                },
            })),
        };

        await withConfigLock(
            redisClient as never,
            'config:test:lock',
            async () => {
                redisState.set('config:test:lock', 'someone-else');
                return { status: 200, body: { success: true } };
            },
            { renewalIntervalMs: 0 },
        );

        assert.strictEqual(redisState.get('config:test:lock'), 'someone-else');
    });

    test('postRepos logs activity after releasing the repo config lock', async () => {
        const redisState = new Map<string, string>();
        let lockHeldDuringActivityLog: boolean | null = null;
        const saveReposMock = mock.fn(async () => true);
        const routes = createConfigRoutes({
            redisClient: {
                set: mock.fn(async (key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
                    if (opts.NX && redisState.has(key)) return null;
                    redisState.set(key, value);
                    return 'OK';
                }),
                publish: mock.fn(async () => 1),
                eval: mock.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
                    const [key] = options.keys;
                    const [lockValue, timeoutSeconds] = options.arguments;
                    if (timeoutSeconds === undefined) {
                        if (redisState.get(key) === lockValue) {
                            redisState.delete(key);
                            return 1;
                        }
                        return 0;
                    }
                    return redisState.get(key) === lockValue ? 1 : 0;
                }),
                lPush: mock.fn(async () => {
                    lockHeldDuringActivityLog = redisState.has('config:repos:lock');
                    return 1;
                }),
                lTrim: mock.fn(async () => 'OK'),
            } as never,
            configStore: {
                loadMonitoredReposRaw: async () => [],
                saveMonitoredRepos: saveReposMock,
                clearRemovedRepositoryIndexData: async () => {},
            },
            database: {
                transaction: async (callback: (trx: never) => Promise<unknown>) => callback({} as never),
            } as never,
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postRepos({
            body: {
                repos_to_monitor: [
                    { name: 'integry/propr', enabled: true },
                ],
            },
            user: { username: 'alice' },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(lockHeldDuringActivityLog, false);
        assert.strictEqual(saveReposMock.mock.calls.length, 1);
    });

    test('postSettings short-circuits empty updates before acquiring the shared settings lock', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
        };
        const routes = createConfigRoutes({ redisClient: redisClient as never });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postSettings({ body: { settings: {} } } as never, res as never);

        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, { success: true, settings: {}, noop: true });
        assert.strictEqual(redisClient.set.mock.calls.length, 0);
    });

    test('withConfigLock reports lock loss when ownership changes during renewal', async () => {
        const redisState = new Map<string, string>();
        const redisClient = {
            set: mock.fn(async (key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
                if (opts.NX && redisState.has(key)) return null;
                redisState.set(key, value);
                return 'OK';
            }),
            del: mock.fn(async (key: string) => {
                redisState.delete(key);
                return 1;
            }),
            eval: mock.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
                const [key] = options.keys;
                const [lockValue, timeoutSeconds] = options.arguments;
                if (timeoutSeconds === undefined) {
                    if (redisState.get(key) === lockValue) {
                        redisState.delete(key);
                        return 1;
                    }
                    return 0;
                }
                return redisState.get(key) === lockValue ? 1 : 0;
            }),
        };

        const result = await withConfigLock(
            redisClient as never,
            'config:test:lock',
            async () => {
                await new Promise(resolve => setTimeout(resolve, 5));
                redisState.set('config:test:lock', 'someone-else');
                await new Promise(resolve => setTimeout(resolve, 20));
                return { status: 200, body: { success: true } };
            },
            { timeoutSeconds: 1, renewalIntervalMs: 10 },
        );

        assert.strictEqual(result.status, 409);
        assert.deepStrictEqual(result.body, {
            error: 'Configuration update lock was lost before the operation completed. Verify the current configuration before retrying.',
            lock_lost: true,
        });
        assert.strictEqual(redisState.get('config:test:lock'), 'someone-else');
    });

    test('withConfigLock fails closed when lock loss is detected after the protected operation returns', async () => {
        const redisState = new Map<string, string>();
        const redisClient = {
            set: mock.fn(async (key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
                if (opts.NX && redisState.has(key)) return null;
                redisState.set(key, value);
                return 'OK';
            }),
            del: mock.fn(async (key: string) => {
                redisState.delete(key);
                return 1;
            }),
            eval: mock.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
                const [key] = options.keys;
                const [lockValue, timeoutSeconds] = options.arguments;
                if (timeoutSeconds === undefined) {
                    if (redisState.get(key) === lockValue) {
                        redisState.delete(key);
                        return 1;
                    }
                    return 0;
                }
                return redisState.get(key) === lockValue ? 1 : 0;
            }),
        };

        const result = await withConfigLock(
            redisClient as never,
            'config:test:lock',
            async lock => {
                lock.markCommitted();
                await new Promise(resolve => setTimeout(resolve, 5));
                redisState.set('config:test:lock', 'someone-else');
                await new Promise(resolve => setTimeout(resolve, 20));
                return { status: 200, body: { success: true } };
            },
            { timeoutSeconds: 1, renewalIntervalMs: 10 },
        );

        assert.strictEqual(result.status, 409);
        assert.deepStrictEqual(result.body, {
            success: true,
            warning: 'Configuration changes were committed, but the update lock was lost afterward. Verify the current configuration before retrying.',
            committed: true,
            lock_lost_after_commit: true,
        });
    });

    test('withConfigLock reports committed state when the final ownership check first detects replacement', async () => {
        let currentLockValue: string | null = null;
        let renewalCalls = 0;
        const redisClient = {
            set: mock.fn(async (_key: string, value: string) => {
                currentLockValue = value;
                return 'OK';
            }),
            eval: mock.fn(async (_script: string, options: { arguments: string[] }) => {
                const [lockValue, timeoutSeconds] = options.arguments;
                if (timeoutSeconds === undefined) {
                    if (currentLockValue === lockValue) currentLockValue = null;
                    return 1;
                }
                renewalCalls += 1;
                if (renewalCalls === 1) currentLockValue = 'replacement-owner';
                return 0;
            }),
        };

        const result = await withConfigLock(
            redisClient as never,
            'config:test:lock',
            async lock => {
                lock.markCommitted();
                return { status: 200, body: { success: true } };
            },
            { renewalIntervalMs: 0 },
        );

        assert.strictEqual(renewalCalls, 1);
        assert.strictEqual(result.status, 409);
        assert.deepStrictEqual(result.body, {
            success: true,
            warning: 'Configuration changes were committed, but the update lock was lost afterward. Verify the current configuration before retrying.',
            committed: true,
            lock_lost_after_commit: true,
        });
        assert.strictEqual(currentLockValue, 'replacement-owner');
    });

    test('parseClaudeOutputToConversationResult preserves usage on assistant lines with content', () => {
        const result = parseClaudeOutputToConversationResult(JSON.stringify({
            type: 'assistant',
            timestamp: '2026-05-05T07:00:00.000Z',
            message: {
                content: [
                    { type: 'text', text: 'Thinking' },
                ],
                usage: {
                    input_tokens: 11,
                    output_tokens: 7,
                    cache_creation_input_tokens: 3,
                    cache_read_input_tokens: 2,
                },
            },
        }));

        assert.deepStrictEqual(result.events, [
            { type: 'thought', content: 'Thinking', timestamp: '2026-05-05T07:00:00.000Z' },
        ]);
        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 11,
            output_tokens: 7,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 2,
        });
    });

    test('applyAgentsUpdate does not fail after commit when activity logging throws', async () => {
        const registry = {
            refresh: mock.fn(async () => {}),
            setDefaultAgentAlias: mock.fn((_alias: string | null) => {}),
        };
        const configStore = {
            loadAgents: async () => currentAgents as never[],
            loadSettings: async () => currentSettings,
            handleSettingsSaveSideEffects: () => {},
            saveAgents: async (agents: never[]) => {
                currentAgents = agents as Array<Record<string, unknown>>;
                return true;
            },
            saveSettings: async (settings: Record<string, unknown>) => {
                currentSettings = { ...currentSettings, ...settings };
                return true;
            },
        };

        const result = await applyAgentsUpdate({
            agents: [
                {
                    id: 'new-agent',
                    alias: 'new-default',
                    type: 'claude',
                    enabled: true,
                    dockerImage: 'new:image',
                    configPath: '/tmp/claude',
                    supportedModels: [],
                },
            ],
            username: 'alice',
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {
                throw new Error('redis unavailable');
            },
            configStore,
            database: createTestDatabase(),
            registry,
        });

        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.body.success, true);
        assert.match(String(result.body.agents?.[0]?.dockerImage), /^propr\/agent:bundle-/);
        assert.strictEqual(currentSettings.default_agent_alias, 'new-default');
    });

    test('applyAgentsUpdate reports committed state when publishing agent updates fails after commit', async () => {
        const registry = {
            refresh: mock.fn(async () => {}),
            setDefaultAgentAlias: mock.fn((_alias: string | null) => {}),
        };
        const configStore = {
            loadAgents: async () => currentAgents as never[],
            loadSettings: async () => currentSettings,
            handleSettingsSaveSideEffects: () => {},
        };

        const result = await applyAgentsUpdate({
            agents: [
                {
                    id: 'new-agent',
                    alias: 'new-default',
                    type: 'claude',
                    enabled: true,
                    dockerImage: 'new:image',
                    configPath: '/tmp/claude',
                    supportedModels: [],
                },
            ],
            publishConfigUpdate: async () => {
                throw new Error('publish failed');
            },
            logActivityHelper: async () => {},
            configStore,
            database: createTestDatabase(),
            registry,
        });

        assert.strictEqual(result.status, 500);
        assert.deepStrictEqual(result.body, {
            error: 'Agent configuration was saved, but publishing the config update notification failed. Other processes may still be using stale configuration.',
            committed: true,
        });
        assert.strictEqual(registry.refresh.mock.calls.length, 1);
        assert.strictEqual(registry.setDefaultAgentAlias.mock.calls[0].arguments[0], 'new-default');
    });

    test('parseStoredOutputContent parses Claude JSONL output', () => {
        const parsed = parseStoredOutputContent('{"type":"assistant","message":{"content":[{"type":"text","text":"Claude says hi"}]}}\n');

        assert.strictEqual(parsed.format, 'claude');
        assert.ok(parsed.parsed);
        assert.deepStrictEqual(parsed.parsed?.events, [
            { type: 'thought', content: 'Claude says hi', timestamp: parsed.parsed?.events[0].timestamp },
        ]);
    });

    test('parseStoredOutputContent parses Codex assistant output', () => {
        const parsed = parseStoredOutputContent('{"type":"message","role":"assistant","content":"Codex says hi"}\n');

        assert.strictEqual(parsed.format, 'codex');
        assert.ok(parsed.parsed);
        assert.deepStrictEqual(parsed.parsed?.events, [
            { type: 'thought', content: 'Codex says hi', timestamp: undefined },
        ]);
    });

    test('parseOpenCodeOutputToConversationResult preserves multiple assistant messages', () => {
        const result = parseOpenCodeOutputToConversationResult([
            '{"type":"message","sessionID":"session-a","timestamp":"2026-05-05T00:00:00.000Z","message":{"role":"assistant","content":"First answer"}}',
            '{"type":"message","sessionID":"session-a","timestamp":"2026-05-05T00:00:02.000Z","message":{"role":"assistant","parts":[{"type":"text","text":"Second "},{"type":"text","text":"answer"}]}}',
        ].join('\n'));

        assert.deepStrictEqual(result?.events, [
            { type: 'message', content: 'First answer', timestamp: '2026-05-05T00:00:00.000Z' },
            { type: 'message', content: 'Second answer', timestamp: '2026-05-05T00:00:02.000Z' },
        ]);
    });

    test('parseOpenCodeOutputToConversationResult buffers stored delta output', () => {
        const result = parseOpenCodeOutputToConversationResult([
            '{"type":"delta","sessionID":"session-a","timestamp":"2026-05-05T00:00:00.000Z","delta":"Hello "}',
            '{"type":"delta","sessionID":"session-a","timestamp":"2026-05-05T00:00:01.000Z","delta":"world"}',
            '{"type":"message","sessionID":"session-a","timestamp":"2026-05-05T00:00:02.000Z","message":{"role":"assistant","content":"Done"}}',
        ].join('\n'));

        assert.deepStrictEqual(result?.events, [
            { type: 'thought', content: 'Hello world', timestamp: '2026-05-05T00:00:00.000Z' },
            { type: 'message', content: 'Done', timestamp: '2026-05-05T00:00:02.000Z' },
        ]);
    });

    test('parseOpenCodeOutputToConversationResult avoids duplicate aggregate and part text', () => {
        const result = parseOpenCodeOutputToConversationResult(
            '{"type":"message","sessionID":"session-a","message":{"role":"assistant","content":"Duplicated","parts":[{"type":"text","text":"Duplicated"}]}}\n'
        );

        assert.deepStrictEqual(result?.events, [
            { type: 'message', content: 'Duplicated', timestamp: result?.events[0].timestamp },
        ]);
    });

    test('parseOpenCodeOutputToConversationResult avoids duplicate top-level and message text', () => {
        const result = parseOpenCodeOutputToConversationResult(
            '{"type":"message","sessionID":"session-a","part":{"type":"text","text":"Duplicated"},"message":{"role":"assistant","content":"Duplicated"}}\n'
        );

        assert.deepStrictEqual(result?.events, [
            { type: 'message', content: 'Duplicated', timestamp: result?.events[0].timestamp },
        ]);
    });

    test('parseOpenCodeOutputToConversationResult does not treat user parts as assistant text', () => {
        const result = parseOpenCodeOutputToConversationResult(
            '{"type":"message","sessionID":"session-a","part":{"type":"text","text":"hidden"},"message":{"role":"user","content":"user text"}}\n'
        );

        assert.strictEqual(result, null);
    });

    test('parseOpenCodeOutputToConversationResult preserves tool events', () => {
        const result = parseOpenCodeOutputToConversationResult([
            '{"type":"tool_use","sessionID":"session-a","tool_name":"Shell","tool_id":"tool-1","parameters":{"command":"npm test"},"timestamp":"2026-05-05T00:00:00.000Z"}',
            '{"type":"tool_result","sessionID":"session-a","tool_id":"tool-1","output":"passed","status":"success","timestamp":"2026-05-05T00:00:01.000Z"}',
        ].join('\n'));

        assert.deepStrictEqual(result?.events, [
            { type: 'tool_use', toolName: 'Shell', input: { command: 'npm test' }, id: 'tool-1', timestamp: '2026-05-05T00:00:00.000Z' },
            { type: 'tool_result', toolUseId: 'tool-1', result: 'passed', isError: false, timestamp: '2026-05-05T00:00:01.000Z' },
        ]);
    });

    test('parseOpenCodeOutputToConversationResult reads response text containers', () => {
        const result = parseOpenCodeOutputToConversationResult(
            '{"type":"message","sessionID":"session-a","response":{"text":"Response text"},"timestamp":"2026-05-05T00:00:00.000Z"}\n'
        );

        assert.deepStrictEqual(result?.events, [
            { type: 'thought', content: 'Response text', timestamp: '2026-05-05T00:00:00.000Z' },
        ]);
    });

    test('parseStoredOutputContent parses strongly identified OpenCode output', () => {
        const parsed = parseStoredOutputContent('{"type":"message","sessionID":"session-a","message":{"role":"assistant","content":"OpenCode says hi"}}\n');

        assert.strictEqual(parsed.format, 'opencode');
        assert.deepStrictEqual(parsed.parsed?.events, [
            { type: 'message', content: 'OpenCode says hi', timestamp: parsed.parsed?.events[0].timestamp },
        ]);
    });

    test('parseStoredOutputContent detects OpenCode after initial metadata lines', () => {
        const parsed = parseStoredOutputContent([
            '{"event":"metadata","source":"worker"}',
            '{"type":"text","text":"OpenCode says hi","timestamp":"2026-05-05T00:00:00.000Z"}',
        ].join('\n'));

        assert.strictEqual(parsed.format, 'opencode');
        assert.deepStrictEqual(parsed.parsed?.events, [
            { type: 'thought', content: 'OpenCode says hi', timestamp: '2026-05-05T00:00:00.000Z' },
        ]);
    });

    test('parseStoredOutputContent lets strong OpenCode lines override generic envelopes', () => {
        const parsed = parseStoredOutputContent([
            '{"type":"message","message":{"content":"generic"}}',
            '{"type":"result","sessionID":"session-a","usage":{"input_tokens":18,"output_tokens":5,"cache_read_input_tokens":4}}',
        ].join('\n'));

        assert.strictEqual(parsed.format, 'opencode');
        assert.deepStrictEqual(parsed.parsed?.tokenUsage, {
            input_tokens: 18,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 4,
        });
    });

    test('parseStoredOutputContent detects OpenCode tool events before Codex fallback', () => {
        const parsed = parseStoredOutputContent(
            '{"type":"tool_use","sessionID":"session-a","tool_name":"Shell","tool_id":"tool-1","parameters":{"command":"npm test"},"timestamp":"2026-05-05T00:00:00.000Z"}\n'
        );

        assert.strictEqual(parsed.format, 'opencode');
        assert.deepStrictEqual(parsed.parsed?.events, [
            { type: 'tool_use', toolName: 'Shell', input: { command: 'npm test' }, id: 'tool-1', timestamp: '2026-05-05T00:00:00.000Z' },
        ]);
    });

    test('parseStoredOutputContent keeps ambiguous result-only usage output on the Codex path', () => {
        const parsed = parseStoredOutputContent('{"type":"result","usage":{"input_tokens":10,"output_tokens":3}}\n');

        assert.strictEqual(parsed.format, 'codex');
        assert.deepStrictEqual(parsed.parsed?.tokenUsage, {
            input_tokens: 10,
            output_tokens: 3,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        });
    });

    test('parseStoredOutputContent parses top-level OpenCode text stream output', () => {
        const parsed = parseStoredOutputContent([
            '{"type":"text","text":"OpenCode top-level","timestamp":"2026-05-05T00:00:00.000Z"}',
            '{"type":"error","sessionID":"session-a","error":{"message":"boom"},"timestamp":"2026-05-05T00:00:01.000Z"}',
        ].join('\n'));

        assert.strictEqual(parsed.format, 'opencode');
        assert.deepStrictEqual(parsed.parsed?.events, [
            { type: 'thought', content: 'OpenCode top-level', timestamp: '2026-05-05T00:00:00.000Z' },
            { type: 'tool_result', result: 'boom', isError: true, timestamp: '2026-05-05T00:00:01.000Z' },
        ]);
    });

    test('parseStoredOutputContent parses pretty Vibe transcript arrays', () => {
        const parsed = parseStoredOutputContent(JSON.stringify([
            { role: 'system', content: 'System prompt should not appear' },
            {
                role: 'assistant',
                content: '',
                reasoning_content: 'I will inspect the file.',
                tool_calls: [{
                    id: 'tool-1',
                    function: {
                        name: 'read_file',
                        arguments: '{"path":"vibe_test.py"}',
                    },
                }],
            },
            {
                role: 'tool',
                tool_call_id: 'tool-1',
                name: 'read_file',
                content: 'content: print("Hello from Vibe")',
            },
            {
                role: 'assistant',
                content: 'Changed the greeting to Yo from Vibe.',
            },
        ], null, 2));

        assert.strictEqual(parsed.format, 'vibe');
        assert.ok(parsed.parsed);
        assert.deepStrictEqual(parsed.parsed?.events.map(event => event.type), ['thought', 'tool_use', 'tool_result', 'thought']);
        assert.strictEqual(parsed.parsed?.events[0].content, 'I will inspect the file.');
        assert.strictEqual(parsed.parsed?.events[1].toolName, 'read_file');
        assert.deepStrictEqual(parsed.parsed?.events[1].input, { path: 'vibe_test.py' });
        assert.strictEqual(parsed.parsed?.events[2].result, 'content: print("Hello from Vibe")');
        assert.strictEqual(parsed.parsed?.events[3].content, 'Changed the greeting to Yo from Vibe.');
        assert.ok(!JSON.stringify(parsed.parsed).includes('System prompt should not appear'));
    });

    test('parseCodexOutputToConversationResult preserves token usage without conversation events', () => {
        const result = parseCodexOutputToConversationResult('{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":3,"output_tokens":4}}\n');

        assert.deepStrictEqual(result, {
            events: [],
            todos: [],
            currentTask: null,
            tokenUsage: {
                input_tokens: 9,
                output_tokens: 4,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 3,
            },
        });
    });

    test('parseCodexOutputToConversationResult keeps command completion events even when no output is produced', () => {
        const result = parseCodexOutputToConversationResult([
            '{"type":"item.started","item":{"type":"command_execution","command":"npm test"},"timestamp":"2026-05-05T00:00:00.000Z"}',
            '{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":0},"timestamp":"2026-05-05T00:00:05.000Z"}',
        ].join('\n'));

        assert.deepStrictEqual(result?.events, [
            { type: 'tool_use', toolName: 'command_execution', input: { command: 'npm test' }, timestamp: '2026-05-05T00:00:00.000Z' },
            { type: 'tool_result', result: '', isError: false, timestamp: '2026-05-05T00:00:05.000Z' },
        ]);
    });

    test('parseStoredOutputContent treats Codex error-first output as Codex, not Claude', () => {
        const parsed = parseStoredOutputContent('{"type":"error","message":"boom"}\n');

        assert.strictEqual(parsed.format, 'codex');
        assert.ok(parsed.parsed);
        assert.deepStrictEqual(parsed.parsed?.events, [
            { type: 'tool_result', result: 'boom', isError: true, timestamp: undefined },
        ]);
    });

    test('parseStoredOutputContent falls back to raw output for unsupported streams', () => {
        const parsed = parseStoredOutputContent('{"event":"gemini","message":"hello from gemini"}\n');

        assert.strictEqual(parsed.format, 'unknown');
        assert.strictEqual(parsed.parsed, null);
        assert.deepStrictEqual(parsed.rawFallback, {
            events: [{ type: 'thought', content: '{"event":"gemini","message":"hello from gemini"}' }],
            todos: [],
            currentTask: null,
            tokenUsage: null,
        });
    });

    test('detectStoredOutputFormat does not classify message-only JSON as Claude', () => {
        assert.strictEqual(detectStoredOutputFormat('{"message":"plain message"}\n'), 'unknown');
    });

    test('detectStoredOutputFormat does not treat generic message envelopes as OpenCode', () => {
        assert.strictEqual(detectStoredOutputFormat('{"type":"message","message":{"content":"generic"}}\n'), 'codex');
    });

    test('detectStoredOutputFormat does not treat generic sessionId envelopes as OpenCode', () => {
        assert.strictEqual(detectStoredOutputFormat('{"type":"message","sessionId":"generic-session","message":{"content":"generic"}}\n'), 'codex');
    });

    test('parseStoredOutputContent keeps Claude assistant JSONL with session_id on the Claude path', () => {
        const parsed = parseStoredOutputContent('{"type":"assistant","session_id":"claude-session","message":{"content":[{"type":"text","text":"Claude says hi"}]}}\n');

        assert.strictEqual(parsed.format, 'claude');
        assert.deepStrictEqual(parsed.parsed?.events, [
            { type: 'thought', content: 'Claude says hi', timestamp: parsed.parsed?.events[0].timestamp },
        ]);
    });

    test('detectStoredOutputFormat does not treat generic session_id envelopes as OpenCode', () => {
        assert.strictEqual(detectStoredOutputFormat('{"type":"message","session_id":"generic-session","message":{"content":"generic"}}\n'), 'codex');
    });

    test('parseOpenCodeOutputToConversationResult normalizes Unix-second timestamps', () => {
        const result = parseOpenCodeOutputToConversationResult('{"type":"text","text":"OpenCode seconds","timestamp":1714867200}\n');

        assert.deepStrictEqual(result?.events, [
            { type: 'thought', content: 'OpenCode seconds', timestamp: '2024-05-05T00:00:00.000Z' },
        ]);
    });

    test('parseRedisOutput preserves cache-only OpenCode token usage', () => {
        const result = parseRedisOutput([
            '{"type":"message","sessionID":"session-a","usage":{"cache_creation_input_tokens":4,"cache_read_input_tokens":6}}',
        ]);

        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 6,
        });
    });

    test('parseRedisOutput aggregates per-event OpenCode token usage', () => {
        const result = parseRedisOutput([
            '{"type":"message","sessionID":"session-a","usage":{"input_tokens":3,"output_tokens":1}}',
            '{"type":"message","sessionID":"session-a","usage":{"input_tokens":2,"cache_read_input_tokens":4}}',
        ]);

        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 5,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 4,
        });
    });

    test('parseRedisOutput reads nested OpenCode token usage', () => {
        const result = parseRedisOutput([
            '{"type":"message","sessionID":"session-a","message":{"role":"assistant","content":"hi","usage":{"input_tokens":4,"output_tokens":2}}}',
            '{"type":"message","sessionID":"session-a","response":{"usage":{"cache_read_input_tokens":3}}}',
        ]);

        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 4,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 3,
        });
    });

    test('parseRedisOutput does not overcount cumulative OpenCode usage snapshots', () => {
        const result = parseRedisOutput([
            '{"type":"result","sessionID":"session-a","usage":{"input_tokens":10,"output_tokens":2}}',
            '{"type":"result","sessionID":"session-a","usage":{"input_tokens":18,"output_tokens":5,"cache_read_input_tokens":4}}',
        ]);

        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 18,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 4,
        });
    });

    test('parseRedisOutput preserves OpenCode numeric-string token usage', () => {
        const result = parseRedisOutput([
            '{"type":"result","sessionID":"session-a","usage":{"input_tokens":"18","output_tokens":"5","cache_creation_input_tokens":"2","cache_read_input_tokens":"4"}}',
        ]);

        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 18,
            output_tokens: 5,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 4,
        });
    });

    test('parseRedisOutput sums increasing per-event OpenCode usage outside result snapshots', () => {
        const result = parseRedisOutput([
            '{"type":"message","sessionID":"session-a","usage":{"input_tokens":10,"output_tokens":2}}',
            '{"type":"message","sessionID":"session-a","usage":{"input_tokens":18,"output_tokens":5,"cache_read_input_tokens":4}}',
        ]);

        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 28,
            output_tokens: 7,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 4,
        });
    });

    test('parseRedisOutput does not double count final top-level usage after nested usage', () => {
        const result = parseRedisOutput([
            '{"type":"message","sessionID":"session-a","message":{"role":"assistant","content":"one","usage":{"input_tokens":10,"output_tokens":2}}}',
            '{"type":"message","sessionID":"session-a","message":{"role":"assistant","content":"two","usage":{"input_tokens":8,"output_tokens":3}}}',
            '{"type":"result","sessionID":"session-a","usage":{"input_tokens":18,"output_tokens":5}}',
        ]);

        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 18,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        });
    });

    test('parseRedisOutput keeps ambiguous result-only usage without a session ID on the Codex path', () => {
        const result = parseRedisOutput([
            '{"type":"result","usage":{"input_tokens":10,"output_tokens":3}}',
        ]);

        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 10,
            output_tokens: 3,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        });
    });

    test('parseRedisOutput normalizes Unix-second timestamps', () => {
        const result = parseRedisOutput([
            '{"type":"text","text":"OpenCode seconds","timestamp":1714867200}',
        ]);

        assert.deepStrictEqual(result.events, [
            { type: 'thought', content: 'OpenCode seconds', timestamp: '2024-05-05T00:00:00.000Z' },
        ]);
    });

    test('parseRedisOutput leaves Gemini tool events with stats on the Gemini path', () => {
        const result = parseRedisOutput([
            '{"type":"tool_use","tool_name":"Shell","tool_id":"tool-1","parameters":{"command":"npm test"},"stats":{"input_tokens":10}}',
        ]);

        assert.deepStrictEqual(result.events, [
            { type: 'tool_use', toolName: 'Shell', input: { command: 'npm test' }, id: 'tool-1', timestamp: result.events[0].timestamp },
        ]);
        assert.strictEqual(result.tokenUsage, null);
    });

    test('parseRedisOutput leaves Gemini result stats on the Gemini path', () => {
        const result = parseRedisOutput([
            '{"type":"message","role":"assistant","delta":true,"content":"Gemini "}',
            '{"type":"message","role":"assistant","delta":true,"content":"done"}',
            '{"type":"result","stats":{"input_tokens":10,"output_tokens":3}}',
        ]);

        assert.deepStrictEqual(result.events, [
            { type: 'thought', content: 'Gemini done', timestamp: result.events[0].timestamp },
        ]);
        assert.deepStrictEqual(result.tokenUsage, {
            input_tokens: 10,
            output_tokens: 3,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        });
    });

    test('parseRedisOutput preserves OpenCode tool events with session IDs', () => {
        const result = parseRedisOutput([
            '{"type":"tool_use","sessionID":"session-a","tool_name":"Shell","tool_id":"tool-1","parameters":{"command":"npm test"}}',
            '{"type":"tool_result","sessionID":"session-a","tool_id":"tool-1","output":"passed","status":"success"}',
        ]);

        assert.deepStrictEqual(result.events, [
            { type: 'tool_use', toolName: 'Shell', input: { command: 'npm test' }, id: 'tool-1', timestamp: result.events[0].timestamp },
            { type: 'tool_result', toolUseId: 'tool-1', result: 'passed', isError: false, timestamp: result.events[1].timestamp },
        ]);
    });

    test('parseRedisOutput reads OpenCode response text containers', () => {
        const result = parseRedisOutput([
            '{"type":"message","sessionID":"session-a","response":{"content":"Redis response"},"timestamp":"2026-05-05T00:00:00.000Z"}',
        ]);

        assert.deepStrictEqual(result.events, [
            { type: 'thought', content: 'Redis response', timestamp: '2026-05-05T00:00:00.000Z' },
        ]);
    });

    test('parseRedisOutput keeps the first OpenCode delta timestamp when flushing', () => {
        const result = parseRedisOutput([
            '{"type":"delta","sessionID":"session-a","delta":"Hello ","timestamp":"2026-05-05T00:00:00.000Z"}',
            '{"type":"delta","sessionID":"session-a","delta":"world","timestamp":"2026-05-05T00:00:01.000Z"}',
            '{"type":"tool_use","sessionID":"session-a","tool_name":"Shell","parameters":{"command":"npm test"},"timestamp":"2026-05-05T00:00:02.000Z"}',
        ]);

        assert.deepStrictEqual(result.events, [
            { type: 'thought', content: 'Hello world', timestamp: '2026-05-05T00:00:00.000Z' },
            { type: 'tool_use', toolName: 'Shell', input: { command: 'npm test' }, id: undefined, timestamp: '2026-05-05T00:00:02.000Z' },
        ]);
    });

    test('parseRedisOutput ignores sessionID-only OpenCode envelopes', () => {
        const result = parseRedisOutput([
            '{"type":"message","sessionID":"session-a"}',
        ]);

        assert.deepStrictEqual(result.events, []);
        assert.strictEqual(result.tokenUsage, null);
    });

    test('parseRedisOutput does not treat user OpenCode parts as assistant text', () => {
        const result = parseRedisOutput([
            '{"type":"message","sessionID":"session-a","part":{"type":"text","text":"hidden"},"message":{"role":"user","content":"user text"}}',
        ]);

        assert.deepStrictEqual(result.events, []);
    });

    test('parseRedisOutput normalizes numeric OpenCode timestamps to strings', () => {
        const result = parseRedisOutput([
            '{"type":"message","sessionID":"session-a","timestamp":1777939200000,"message":{"role":"assistant","content":"hi"}}',
        ]);

        assert.deepStrictEqual(result.events, [
            { type: 'thought', content: 'hi', timestamp: '2026-05-05T00:00:00.000Z' },
        ]);
    });

    test('parseRedisOutput avoids duplicate OpenCode aggregate and part text', () => {
        const result = parseRedisOutput([
            '{"type":"message","sessionID":"session-a","message":{"role":"assistant","content":"Duplicated","parts":[{"type":"text","text":"Duplicated"}]}}',
        ]);

        assert.deepStrictEqual(result.events, [
            { type: 'thought', content: 'Duplicated', timestamp: result.events[0].timestamp },
        ]);
    });

    test('parseRedisOutput avoids duplicate OpenCode top-level and message text', () => {
        const result = parseRedisOutput([
            '{"type":"message","sessionID":"session-a","part":{"type":"text","text":"Duplicated"},"message":{"role":"assistant","content":"Duplicated"}}',
        ]);

        assert.deepStrictEqual(result.events, [
            { type: 'thought', content: 'Duplicated', timestamp: result.events[0].timestamp },
        ]);
    });

    test('appendClaudeUserMessageEvents omits object content from subagent summaries', () => {
        const events: Array<Record<string, unknown>> = [];
        const handled = appendClaudeUserMessageEvents(
            [
                {
                    type: 'tool_result',
                    tool_use_id: 'subagent-1',
                    content: [{ type: 'tool_result', content: { nested: true } }],
                },
            ],
            {
                timestamp: '2026-05-05T00:00:10.000Z',
                events,
                pendingSubagents: new Map([
                    ['subagent-1', {
                        toolUseId: 'subagent-1',
                        subagentType: 'explore',
                        description: 'Inspect repository state',
                        startTimestamp: '2026-05-05T00:00:00.000Z',
                    }],
                ]),
                setTodos: () => {},
            },
        );

        assert.strictEqual(handled, true);
        assert.strictEqual(events.length, 2);
        assert.deepStrictEqual(events[1], {
            type: 'subagent_completed',
            toolUseId: 'subagent-1',
            subagentType: 'explore',
            description: 'Inspect repository state',
            durationSeconds: 10,
            content: null,
            timestamp: '2026-05-05T00:00:10.000Z',
        });
    });

    test('config routes log activity for generic admin config updates', async () => {
        const savePrLabelMock = mock.fn(async (_value: string) => true);
        const redisClient = {
            set: mock.fn(async () => 'OK'),
            eval: mock.fn(async () => 1),
            publish: mock.fn(async () => 1),
            lPush: mock.fn(async () => 1),
            lTrim: mock.fn(async () => 1),
        };
        const routes = createConfigRoutes({
            redisClient: redisClient as never,
            configStore: { savePrLabel: savePrLabelMock },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postPrLabel({
            body: { pr_label: 'needs-review' },
            user: { username: 'alice' },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(redisClient.lPush.mock.calls.length, 1);
        const activity = JSON.parse(String(redisClient.lPush.mock.calls[0].arguments[1]));
        assert.strictEqual(activity.type, 'config_updated');
        assert.strictEqual(activity.user, 'alice');
        assert.match(activity.description, /Updated PR label/);
    });

    test('applyAgentsUpdate rejects blank supported model entries', async () => {
        const result = await applyAgentsUpdate({
            agents: [
                {
                    id: 'new-agent',
                    alias: 'new-default',
                    type: 'claude',
                    enabled: true,
                    dockerImage: 'new:image',
                    configPath: '/tmp/claude',
                    supportedModels: ['claude-sonnet-4-6', '   '],
                },
            ],
            publishConfigUpdate: async () => {},
            logActivityHelper: async () => {},
        });

        assert.strictEqual(result.status, 400);
        assert.deepStrictEqual(result.body, {
            error: "Agent 'new-agent' has invalid 'supportedModels'. Each supported model must be a non-empty string",
        });
    });

    test('postFollowupKeywords trims and deduplicates keywords', async () => {
        const saveKeywordsMock = mock.fn(async (_value: string[]) => true);
        const redisClient = {
            set: mock.fn(async () => 'OK'),
            eval: mock.fn(async () => 1),
            publish: mock.fn(async () => 1),
            lPush: mock.fn(async () => 1),
            lTrim: mock.fn(async () => 1),
        };
        const routes = createConfigRoutes({
            redisClient: redisClient as never,
            configStore: { saveFollowupKeywords: saveKeywordsMock },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postFollowupKeywords({
            body: { followup_keywords: ['  bug  ', 'bug', 'feature', '   '] },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, {
            success: true,
            followup_keywords: ['bug', 'feature'],
        });
        assert.deepStrictEqual(saveKeywordsMock.mock.calls[0].arguments[0], ['bug', 'feature']);
    });

    test('postFollowupKeywords rejects a false save result without publishing', async () => {
        const saveKeywordsMock = mock.fn(async (_value: string[]) => false);
        const redisClient = {
            set: mock.fn(async () => 'OK'),
            eval: mock.fn(async () => 1),
            publish: mock.fn(async () => 1),
            lPush: mock.fn(async () => 1),
            lTrim: mock.fn(async () => 1),
        };
        const routes = createConfigRoutes({
            redisClient: redisClient as never,
            configStore: { saveFollowupKeywords: saveKeywordsMock },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postFollowupKeywords({
            body: { followup_keywords: ['bug'] },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 500);
        assert.deepStrictEqual(res.body, {
            error: 'Configuration update was not persisted. No update notification was published.',
        });
        assert.strictEqual(redisClient.publish.mock.calls.length, 0);
        assert.strictEqual(redisClient.lPush.mock.calls.length, 0);
    });

    test('postFollowupKeywords reports committed state when publish fails after save', async () => {
        const saveKeywordsMock = mock.fn(async (_value: string[]) => true);
        const redisClient = {
            set: mock.fn(async () => 'OK'),
            eval: mock.fn(async () => 1),
            publish: mock.fn(async () => {
                throw new Error('publish failed');
            }),
            lPush: mock.fn(async () => 1),
            lTrim: mock.fn(async () => 1),
        };
        const routes = createConfigRoutes({
            redisClient: redisClient as never,
            configStore: { saveFollowupKeywords: saveKeywordsMock },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postFollowupKeywords({
            body: { followup_keywords: ['bug'] },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 500);
        assert.deepStrictEqual(res.body, {
            error: 'Follow-up keywords were saved, but publishing the config update notification failed. Persisted config may require a follow-up check.',
            committed: true,
        });
        assert.strictEqual(saveKeywordsMock.mock.calls.length, 1);
    });

    test('postFollowupKeywords preserves committed lock-loss warnings when the lock is lost after save', async () => {
        const redisState = new Map<string, string>();
        const saveKeywordsMock = mock.fn(async (_value: string[]) => true);
        const routes = createConfigRoutes({
            redisClient: {
                set: mock.fn(async (key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
                    if (opts.NX && redisState.has(key)) return null;
                    redisState.set(key, value);
                    return 'OK';
                }),
                eval: mock.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
                    const [key] = options.keys;
                    const [lockValue, timeoutSeconds] = options.arguments;
                    if (timeoutSeconds === undefined) {
                        if (redisState.get(key) === lockValue) {
                            redisState.delete(key);
                            return 1;
                        }
                        return 0;
                    }
                    return redisState.get(key) === lockValue ? 1 : 0;
                }),
                publish: mock.fn(async () => {
                    redisState.set('config:keywords:lock', 'someone-else');
                    await new Promise(resolve => setTimeout(resolve, 20));
                    return 1;
                }),
                lPush: mock.fn(async () => 1),
                lTrim: mock.fn(async () => 1),
            } as never,
            configStore: { saveFollowupKeywords: saveKeywordsMock },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postFollowupKeywords({
            body: { followup_keywords: ['bug'] },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 409);
        assert.deepStrictEqual(res.body, {
            success: true,
            followup_keywords: ['bug'],
            warning: 'Configuration changes were committed, but the update lock was lost afterward. Verify the current configuration before retrying.',
            committed: true,
            lock_lost_after_commit: true,
        });
        assert.strictEqual(redisState.get('config:keywords:lock'), 'someone-else');
    });

    test('postFollowupKeywords preserves committed state when publish fails after lock loss', async () => {
        const redisState = new Map<string, string>();
        const saveKeywordsMock = mock.fn(async (_value: string[]) => true);
        const routes = createConfigRoutes({
            redisClient: {
                set: mock.fn(async (key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
                    if (opts.NX && redisState.has(key)) return null;
                    redisState.set(key, value);
                    return 'OK';
                }),
                eval: mock.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
                    const [key] = options.keys;
                    const [lockValue, timeoutSeconds] = options.arguments;
                    if (timeoutSeconds === undefined) {
                        if (redisState.get(key) === lockValue) {
                            redisState.delete(key);
                            return 1;
                        }
                        return 0;
                    }
                    return redisState.get(key) === lockValue ? 1 : 0;
                }),
                publish: mock.fn(async () => {
                    redisState.set('config:keywords:lock', 'someone-else');
                    throw new Error('publish failed');
                }),
                lPush: mock.fn(async () => 1),
                lTrim: mock.fn(async () => 1),
            } as never,
            configStore: { saveFollowupKeywords: saveKeywordsMock },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postFollowupKeywords({
            body: { followup_keywords: ['bug'] },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 500);
        assert.deepStrictEqual(res.body, {
            error: 'Follow-up keywords were saved, but publishing the config update notification failed. Persisted config may require a follow-up check.',
            committed: true,
            warning: 'Configuration changes were committed, but the update lock was lost afterward. Verify the current configuration before retrying.',
            lock_lost_after_commit: true,
        });
    });

    test('postFollowupKeywords refuses to save after ownership is lost', async () => {
        const saveKeywordsMock = mock.fn(async (_value: string[]) => true);
        const routes = createConfigRoutes({
            redisClient: {
                set: mock.fn(async () => 'OK'),
                eval: mock.fn(async (_script: string, options: { arguments: string[] }) =>
                    options.arguments.length === 2 ? 0 : 1),
                publish: mock.fn(async () => 1),
                lPush: mock.fn(async () => 1),
                lTrim: mock.fn(async () => 1),
            } as never,
            configStore: { saveFollowupKeywords: saveKeywordsMock },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postFollowupKeywords({
            body: { followup_keywords: ['bug'] },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 409);
        assert.deepStrictEqual(res.body, {
            error: 'Configuration update lock was lost before the operation completed. Verify the current configuration before retrying.',
            lock_lost: true,
        });
        assert.strictEqual(saveKeywordsMock.mock.calls.length, 0);
    });

    test('queueResummarizationForAllRepos uses enabled raw repo names when scheduling jobs', async () => {
        const queueAdds: Array<{ repository: string; runId?: string; transitionAt?: string }> = [];
        const queued = await queueResummarizationForAllRepos({
            deps: createQueueResummarizationDeps({
                repos: [
                    { id: '1', name: 'acme/alpha', enabled: true },
                    { id: '2', name: 'acme/beta', enabled: false },
                    { id: '3', name: 'acme/gamma', enabled: true },
                ],
                queueAdds,
            })
        });
        assert.deepStrictEqual(queued, {
            queued: 2,
            skippedCooldown: 0,
            skippedAlreadyQueued: 0,
            failedClone: 0,
        });
        assert.deepStrictEqual(queueAdds, [
            {
                repository: 'acme/alpha',
                runId: 'test-indexing-run',
                transitionAt: '2026-08-02T08:00:00.000Z',
            },
            {
                repository: 'acme/gamma',
                runId: 'test-indexing-run',
                transitionAt: '2026-08-02T08:00:00.000Z',
            },
        ]);
    });

    test('queueResummarizationForAllRepos reports cooldown and queued skips', async () => {
        const result = await queueResummarizationForAllRepos({
            deps: createQueueResummarizationDeps({
                repos: [
                    { id: '1', name: 'acme/alpha', enabled: true },
                    { id: '2', name: 'acme/beta', enabled: true },
                    { id: '3', name: 'acme/gamma', enabled: true },
                ],
                existingJobs: [{ data: { repository: 'acme/gamma', baseBranch: undefined } }],
                cooldownRepos: new Set(['acme/beta']),
            })
        });
        assert.deepStrictEqual(result, {
            queued: 1,
            skippedCooldown: 1,
            skippedAlreadyQueued: 1,
            failedClone: 0,
        });
    });

    test('indexing jobs remain delayed until durable acceptance promotes them', async () => {
        const queueDelays: number[] = [];
        const promotions: string[] = [];
        const result = await queueResummarizationForAllRepos({
            deps: createQueueResummarizationDeps({
                repos: [{ id: '1', name: 'acme/alpha', enabled: true }],
                queueDelays,
                promotions,
            })
        });

        assert.strictEqual(result.queued, 1);
        assert.deepStrictEqual(queueDelays, [configManager.INDEXING_JOB_ACCEPTANCE_DELAY_MS]);
        assert.strictEqual(promotions.length, 1);
    });

    test('concurrent resummarization requests share one atomic repository job key', async () => {
        const queueAdds: Array<{ repository: string; runId?: string; transitionAt?: string }> = [];
        let run = 0;
        const deps = createQueueResummarizationDeps({
            repos: [{ id: '1', name: 'acme/alpha', enabled: true }],
            queueAdds,
            createRun: () => ({
                runId: `run-${++run}`,
                transitionAt: `2026-08-02T08:0${run}:00.000Z`,
            }),
        });

        const results = await Promise.all([
            queueResummarizationForAllRepos({ deps }),
            queueResummarizationForAllRepos({ deps }),
        ]);

        assert.strictEqual(results.reduce((total, result) => total + result.queued, 0), 1);
        assert.strictEqual(results.reduce((total, result) => total + result.skippedAlreadyQueued, 0), 1);
        assert.strictEqual(queueAdds.length, 2);
    });

    test('a duplicate enqueue stays rejected when its winning job is removed immediately', async () => {
        let run = 0;
        const publications: string[] = [];
        const deps = createQueueResummarizationDeps({
            repos: [{ id: '1', name: 'acme/removal-race', enabled: true }],
            removeWinnerOnDuplicate: true,
            publications,
            createRun: () => ({
                runId: `removal-race-${++run}`,
                transitionAt: `2026-08-02T08:0${run}:00.000Z`,
            }),
        });

        const results = await Promise.all([
            queueResummarizationForAllRepos({ deps }),
            queueResummarizationForAllRepos({ deps }),
        ]);

        assert.strictEqual(results.reduce((total, result) => total + result.queued, 0), 1);
        assert.strictEqual(results.reduce((total, result) => total + result.skippedAlreadyQueued, 0), 1);
        assert.strictEqual(publications.length, 1);
        assert.match(publications[0], /^removal-race-[12]$/);
    });

    test('a rejected resummarization enqueue never advances repository state', async () => {
        const statusMutations: string[] = [];
        await assert.rejects(
            queueResummarizationForAllRepos({
                deps: createQueueResummarizationDeps({
                    repos: [{ id: '1', name: 'acme/alpha', enabled: true }],
                    queueAddError: new Error('queue unavailable'),
                    statusMutations,
                }),
            }),
            /queue unavailable/
        );
        assert.deepStrictEqual(statusMutations, []);
    });

    test('stopIndexingJob cancels and transitions active and queued legacy jobs', async () => {
        const cancellations: Array<{ repository: string; branch: string; runId?: string }> = [];
        const transitions: Array<{ branch: string; runId?: string }> = [];
        const publications: Array<{ branch: string; runId: string }> = [];
        const removed: string[] = [];
        const jobs = [
            {
                id: 'legacy-active-job',
                data: { repository: 'acme/alpha', baseBranch: 'main' },
                getState: async () => 'active',
                remove: async () => { removed.push('main'); },
            },
            {
                id: 'legacy-waiting-job',
                data: { repository: 'acme/alpha', baseBranch: 'dev' },
                getState: async () => 'waiting',
                remove: async () => { removed.push('dev'); },
            },
        ];

        const result = await stopIndexingJob('acme/alpha', undefined, {
            getIndexingQueue: async () => ({ getJobs: async () => jobs } as never),
            createLegacyIndexingRunIdForJob: (_repository, branch) => `legacy-${branch}`,
            requestIndexingCancellation: async (repository, branch, runId) => {
                cancellations.push({ repository, branch, runId });
            },
            updateRepositoryStatus: async (_repository, _status, branch, run = {}) => {
                transitions.push({ branch, runId: run.runId });
                return {
                    applied: true,
                    transitionAt: `2026-08-02T08:0${transitions.length}:00.000Z`,
                    runId: run.runId ?? `legacy-${branch}`,
                };
            },
            publishIndexingStatus: async (_repository, branch, _phase, transition) => {
                publications.push({ branch, runId: transition!.runId });
            },
        });

        assert.deepStrictEqual(cancellations, [
            { repository: 'acme/alpha', branch: 'main', runId: 'legacy-main' },
        ]);
        assert.deepStrictEqual(removed, ['dev']);
        assert.deepStrictEqual(transitions, [
            { branch: 'main', runId: 'legacy-main' },
            { branch: 'dev', runId: 'legacy-dev' },
        ]);
        assert.deepStrictEqual(publications, [
            { branch: 'main', runId: 'legacy-main' },
            { branch: 'dev', runId: 'legacy-dev' },
        ]);
        assert.deepStrictEqual(result, {
            success: true,
            cancelledActiveRuns: [{
                branch: 'main',
                runId: 'legacy-main',
                transitionAt: '2026-08-02T08:01:00.000Z',
            }],
            removedQueuedRuns: [{
                branch: 'dev',
                runId: 'legacy-dev',
                transitionAt: '2026-08-02T08:02:00.000Z',
            }],
        });
    });

    test('stopIndexingJob keeps a durable stop successful when projection fails', async () => {
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({
                getJobs: async () => [{
                    data: { repository: 'acme/api', baseBranch: 'main', runId: 'run-1' },
                    getState: async () => 'waiting',
                    remove: async () => undefined,
                }],
            } as never),
            requestIndexingCancellation: async () => undefined,
            updateRepositoryStatus: async () => ({
                runId: 'run-1',
                transitionAt: '2026-08-02T08:00:00.000Z',
                applied: true,
            }),
            publishIndexingStatus: async () => { throw new Error('projection unavailable'); },
        });

        assert.deepStrictEqual(result, {
            success: true,
            cancelledActiveRuns: [],
            removedQueuedRuns: [{
                branch: 'main',
                runId: 'run-1',
                transitionAt: '2026-08-02T08:00:00.000Z',
            }],
        });
    });

    test('stopIndexingJob does not publish a rejected stale-run transition', async () => {
        let publications = 0;
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({
                getJobs: async () => [{
                    data: { repository: 'acme/api', baseBranch: 'main', runId: 'stale-run' },
                    getState: async () => 'waiting',
                    remove: async () => undefined,
                }],
            } as never),
            requestIndexingCancellation: async () => undefined,
            updateRepositoryStatus: async () => ({
                runId: 'stale-run',
                transitionAt: '2026-08-02T08:00:00.000Z',
                applied: false,
            }),
            publishIndexingStatus: async () => { publications++; },
        });

        assert.deepStrictEqual(result, {
            success: true,
            cancelledActiveRuns: [],
            removedQueuedRuns: [],
        });
        assert.strictEqual(publications, 0);
    });

    test('stopIndexingJob derives durable stop evidence from a legacy job timestamp', async () => {
        const queuedAt = '2026-08-02T07:59:00.000Z';
        let recordedTransitionAt: string | undefined;
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({
                getJobs: async () => [{
                    id: 'legacy-queued-job',
                    timestamp: Date.parse(queuedAt),
                    data: { repository: 'acme/api', baseBranch: 'main' },
                    getState: async () => 'waiting',
                    remove: async () => undefined,
                }],
            } as never),
            createLegacyIndexingRunIdForJob: () => 'legacy-queued-run',
            requestIndexingCancellation: async () => undefined,
            updateRepositoryStatus: async () => ({
                runId: 'legacy-queued-run',
                transitionAt: '2026-08-02T08:00:00.000Z',
                applied: false,
            }),
            recordSkippedIndexingRun: async (_repository, _branch, run) => {
                recordedTransitionAt = run.transitionAt;
                return { ...run, applied: true };
            },
            publishIndexingStatus: async () => undefined,
        });

        assert.strictEqual(recordedTransitionAt, queuedAt);
        assert.deepStrictEqual(result.removedQueuedRuns, [{
            branch: 'main',
            runId: 'legacy-queued-run',
            transitionAt: queuedAt,
        }]);
    });

    test('stopIndexingJob preserves a terminal result that beats active cancellation', async () => {
        let skippedRunWrites = 0;
        let publications = 0;
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({
                getJobs: async () => [{
                    data: {
                        repository: 'acme/api',
                        baseBranch: 'main',
                        runId: 'completed-run',
                        transitionAt: '2026-08-02T08:00:00.000Z',
                    },
                    getState: async () => 'active',
                    remove: async () => undefined,
                }],
            } as never),
            requestIndexingCancellation: async () => undefined,
            updateRepositoryStatus: async () => ({
                runId: 'completed-run',
                transitionAt: '2026-08-02T08:01:00.000Z',
                applied: false,
            }),
            recordSkippedIndexingRun: async () => {
                skippedRunWrites++;
                return {
                    runId: 'completed-run',
                    transitionAt: '2026-08-02T08:01:00.000Z',
                    applied: false,
                };
            },
            publishIndexingStatus: async () => { publications++; },
        });

        assert.deepStrictEqual(result, {
            success: true,
            cancelledActiveRuns: [],
            removedQueuedRuns: [],
        });
        assert.strictEqual(skippedRunWrites, 1);
        assert.strictEqual(publications, 0);
    });

    test('stopIndexingJob closes an active run before its ownership write lands', async () => {
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({
                getJobs: async () => [{
                    data: {
                        repository: 'acme/api',
                        baseBranch: 'main',
                        runId: 'starting-run',
                        transitionAt: '2026-08-02T08:00:00.000Z',
                    },
                    getState: async () => 'active',
                    remove: async () => undefined,
                }],
            } as never),
            requestIndexingCancellation: async () => undefined,
            updateRepositoryStatus: async () => ({
                runId: 'starting-run',
                transitionAt: '2026-08-02T08:00:00.000Z',
                applied: false,
            }),
            recordSkippedIndexingRun: async (_repository, _branch, run) => ({
                runId: run.runId,
                transitionAt: '2026-08-02T08:01:00.000Z',
                applied: true,
            }),
            publishIndexingStatus: async () => undefined,
        });

        assert.deepStrictEqual(result.cancelledActiveRuns, [{
            branch: 'main',
            runId: 'starting-run',
            transitionAt: '2026-08-02T08:01:00.000Z',
        }]);
    });

    test('stopIndexingJob records a queued cancellation owned by a previous run', async () => {
        const skippedRuns: string[] = [];
        const publications: string[] = [];
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({
                getJobs: async () => [{
                    data: {
                        repository: 'acme/api',
                        baseBranch: 'main',
                        runId: 'queued-run',
                        transitionAt: '2026-08-02T08:00:00.000Z',
                    },
                    getState: async () => 'waiting',
                    remove: async () => undefined,
                }],
            } as never),
            requestIndexingCancellation: async () => undefined,
            updateRepositoryStatus: async () => ({
                runId: 'queued-run',
                transitionAt: '2026-08-02T08:00:00.000Z',
                applied: false,
            }),
            recordSkippedIndexingRun: async (_repository, _branch, run) => {
                skippedRuns.push(run.runId);
                return {
                    runId: run.runId,
                    transitionAt: '2026-08-02T08:01:00.000Z',
                    applied: true,
                };
            },
            publishIndexingStatus: async (_repository, _branch, _phase, transition) => {
                publications.push(transition!.runId);
            },
        });

        assert.deepStrictEqual(skippedRuns, ['queued-run']);
        assert.deepStrictEqual(publications, ['queued-run']);
        assert.deepStrictEqual(result.removedQueuedRuns, [{
            branch: 'main',
            runId: 'queued-run',
            transitionAt: '2026-08-02T08:01:00.000Z',
        }]);
    });

    test('stopIndexingJob follows a waiting job that becomes active during removal', async () => {
        let stateReads = 0;
        const cancellations: string[] = [];
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({
                getJobs: async () => [{
                    data: {
                        repository: 'acme/api',
                        baseBranch: 'main',
                        runId: 'starting-run',
                        transitionAt: '2026-08-02T08:00:00.000Z',
                    },
                    getState: async () => stateReads++ === 0 ? 'waiting' : 'active',
                    remove: async () => { throw new Error('job is active'); },
                }],
            } as never),
            requestIndexingCancellation: async (_repository, _branch, runId) => {
                cancellations.push(runId!);
            },
            updateRepositoryStatus: async () => ({
                runId: 'starting-run',
                transitionAt: '2026-08-02T08:01:00.000Z',
                applied: true,
            }),
            publishIndexingStatus: async () => undefined,
        });

        assert.deepStrictEqual(cancellations, ['starting-run']);
        assert.deepStrictEqual(result.cancelledActiveRuns, [{
            branch: 'main',
            runId: 'starting-run',
            transitionAt: '2026-08-02T08:01:00.000Z',
        }]);
    });

    test('stopIndexingJob uses the job repository spelling for active runtime state', async () => {
        const cancellations: string[] = [];
        const statusRepositories: string[] = [];
        const publicationRepositories: string[] = [];
        const result = await stopIndexingJob('Acme/API', 'main', {
            getIndexingQueue: async () => ({
                getJobs: async () => [{
                    data: {
                        repository: 'acme/api',
                        baseBranch: 'main',
                        runId: 'case-run',
                    },
                    getState: async () => 'active',
                    remove: async () => undefined,
                }],
            } as never),
            requestIndexingCancellation: async (repository) => { cancellations.push(repository); },
            updateRepositoryStatus: async (repository) => {
                statusRepositories.push(repository);
                return {
                    runId: 'case-run',
                    transitionAt: '2026-08-03T10:00:00.000Z',
                    applied: true,
                };
            },
            publishIndexingStatus: async (repository) => { publicationRepositories.push(repository); },
        });

        assert.deepStrictEqual(cancellations, ['acme/api']);
        assert.deepStrictEqual(statusRepositories, ['acme/api']);
        assert.deepStrictEqual(publicationRepositories, ['acme/api']);
        assert.strictEqual(result.success, true);
    });

    test('stopIndexingJob reports failure when a queued job remains queued after removal fails', async () => {
        let statusWrites = 0;
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({
                getJobs: async () => [{
                    data: { repository: 'acme/api', baseBranch: 'main', runId: 'waiting-run' },
                    getState: async () => 'waiting',
                    remove: async () => { throw new Error('Redis remove failed'); },
                }],
            } as never),
            requestIndexingCancellation: async () => undefined,
            updateRepositoryStatus: async () => {
                statusWrites++;
                return {
                    runId: 'waiting-run',
                    transitionAt: '2026-08-03T10:01:00.000Z',
                    applied: true,
                };
            },
            publishIndexingStatus: async () => undefined,
        });

        assert.strictEqual(result.success, false);
        assert.match(result.message ?? '', /queue state is still waiting/);
        assert.strictEqual(statusWrites, 1);
    });

    test('stopIndexingJob leaves a queued job recoverable when the terminal write fails', async () => {
        let removals = 0;
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({
                getJobs: async () => [{
                    data: {
                        repository: 'acme/api',
                        baseBranch: 'main',
                        runId: 'recoverable-run',
                        transitionAt: '2026-08-03T10:00:00.000Z',
                    },
                    getState: async () => 'waiting',
                    remove: async () => { removals++; },
                }],
            } as never),
            updateRepositoryStatus: async () => { throw new Error('SQLite write failed'); },
        });

        assert.strictEqual(result.success, false);
        assert.match(result.message ?? '', /SQLite write failed/);
        assert.strictEqual(removals, 0);
    });

    test('stopIndexingJob closes a durable orphan when the queue lost its job', async () => {
        const publications: string[] = [];
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({ getJobs: async () => [] } as never),
            getActiveRepositoryIndexingRuns: async () => [{
                fullName: 'acme/api',
                branch: 'main',
                runId: 'orphaned-run',
                transitionAt: '2026-08-03T10:00:00.000Z',
            }],
            updateRepositoryStatus: async (_repository, status, _branch, options) => ({
                runId: options.runId!,
                transitionAt: '2026-08-03T10:01:00.000Z',
                applied: status === 'idle',
            }),
            publishIndexingStatus: async (_repository, _branch, phase) => {
                publications.push(phase);
            },
        });

        assert.deepStrictEqual(publications, ['idle']);
        assert.deepStrictEqual(result, {
            success: true,
            message: 'Stopped 1 orphaned durable indexing run(s)',
            cancelledActiveRuns: [{
                branch: 'main',
                runId: 'orphaned-run',
                transitionAt: '2026-08-03T10:01:00.000Z',
            }],
            removedQueuedRuns: [],
        });
    });

    test('stopIndexingJob falls back to a durable run when a snapshotted job turns terminal', async () => {
        let durableLookups = 0;
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({
                getJobs: async () => [{
                    data: { repository: 'acme/api', baseBranch: 'main', runId: 'vanished-run' },
                    getState: async () => 'completed',
                    remove: async () => { throw new Error('job completed during remove'); },
                }],
            } as never),
            getActiveRepositoryIndexingRuns: async () => {
                durableLookups++;
                return [{
                    fullName: 'acme/api',
                    branch: 'main',
                    runId: 'orphaned-owner',
                    transitionAt: '2026-08-03T10:00:00.000Z',
                }];
            },
            updateRepositoryStatus: async (_repository, _status, _branch, options) => ({
                runId: options.runId!,
                transitionAt: '2026-08-03T10:01:00.000Z',
                applied: true,
            }),
            publishIndexingStatus: async () => undefined,
        });

        assert.strictEqual(durableLookups, 1);
        assert.deepStrictEqual(result.cancelledActiveRuns, [{
            branch: 'main',
            runId: 'orphaned-owner',
            transitionAt: '2026-08-03T10:01:00.000Z',
        }]);
    });

    test('stopIndexingJob reports a meaningful no-op when nothing is active', async () => {
        const result = await stopIndexingJob('acme/api', 'main', {
            getIndexingQueue: async () => ({ getJobs: async () => [] } as never),
            getActiveRepositoryIndexingRuns: async () => [],
        });

        assert.deepStrictEqual(result, {
            success: true,
            message: 'No queued or durable active indexing run matched the request',
            cancelledActiveRuns: [],
            removedQueuedRuns: [],
        });
    });

    function createQueueResummarizationDeps(options: {
        repos: Array<{ id: string; name: string; enabled: boolean }>;
        existingJobs?: Array<{ data: { repository: string; baseBranch?: string } }>;
        cooldownRepos?: Set<string>;
        queueAdds?: Array<{ repository: string; runId?: string; transitionAt?: string }>;
        createRun?: () => { runId: string; transitionAt: string };
        queueAddError?: Error;
        queueDelays?: number[];
        promotions?: string[];
        statusMutations?: string[];
        publications?: string[];
        removeWinnerOnDuplicate?: boolean;
    }) {
        const queuedByDeduplicationId = new Map<string, string>();
        return {
            loadMonitoredReposRaw: async () => options.repos,
            getAuthenticatedOctokit: async () => ({
                auth: async () => ({ token: 'test-token' }),
            } as never),
            getSummarizationCooldown: async (repoFullName: string) => (
                options.cooldownRepos?.has(repoFullName)
                    ? { repository: repoFullName, branch: 'HEAD', until: new Date(Date.now() + 60000).toISOString(), reason: 'quota-limited' }
                    : null
            ),
            ensureRepoCloned: async ({ owner, repoName }: { owner: string; repoName: string }) => `/tmp/${owner}-${repoName}`,
            fetchLatestChanges: async () => ({ success: true }),
            getRepoUrl: ({ repoOwner, repoName }: { repoOwner: string; repoName: string }) => `https://example.com/${repoOwner}/${repoName}.git`,
            createIndexingRunIdentity: options.createRun ?? (() => ({
                runId: 'test-indexing-run',
                transitionAt: '2026-08-02T08:00:00.000Z',
            })),
            publishIndexingStatus: async (
                _repository: string,
                _branch: string,
                _phase: string,
                transition?: { runId: string },
            ) => {
                if (transition) options.publications?.push(transition.runId);
            },
            updateRepositoryStatus: async (
                repository: string,
                _status: 'idle' | 'indexing' | 'completed' | 'failed',
                _branch: string,
                run: { runId?: string; transitionAt?: string } = {},
            ) => {
                options.statusMutations?.push(repository);
                return {
                    runId: run.runId ?? 'test-indexing-run',
                    transitionAt: run.transitionAt ?? '2026-08-02T08:01:00.000Z',
                    applied: true,
                };
            },
            getIndexingQueue: async () => ({
                getJobs: async () => options.existingJobs || [],
                add: async (_name: string, data: {
                    repository: string;
                    runId?: string;
                    transitionAt?: string;
                }, jobOptions: {
                    jobId?: string;
                    delay?: number;
                    deduplication?: { id: string };
                }) => {
                    if (options.queueAddError) throw options.queueAddError;
                    if (jobOptions.delay !== undefined) options.queueDelays?.push(jobOptions.delay);
                    options.queueAdds?.push({
                        repository: data.repository,
                        runId: data.runId,
                        transitionAt: data.transitionAt,
                    });
                    const requestedJobId = jobOptions.jobId!;
                    const deduplicationId = jobOptions.deduplication!.id;
                    const existingJobId = queuedByDeduplicationId.get(deduplicationId);
                    if (existingJobId) {
                        if (options.removeWinnerOnDuplicate) {
                            // BullMQ's duplicate result remains the winner's ID even
                            // if the worker removes that job before the caller resumes.
                            queuedByDeduplicationId.delete(deduplicationId);
                        }
                        return { id: existingJobId };
                    }
                    queuedByDeduplicationId.set(deduplicationId, requestedJobId);
                    return {
                        id: requestedJobId,
                        promote: async () => { options.promotions?.push(requestedJobId); }
                    };
                },
            } as never),
        };
    }

    test('postRepos reports committed state when publish fails after save', async () => {
        const saveReposMock = mock.fn(async () => true);
        const routes = createConfigRoutes({
            redisClient: {
                set: mock.fn(async () => 'OK'),
                publish: mock.fn(async () => {
                    throw new Error('publish failed');
                }),
                eval: mock.fn(async () => 1),
                lPush: mock.fn(async () => 1),
                lTrim: mock.fn(async () => 'OK'),
            } as never,
            configStore: {
                loadMonitoredReposRaw: async () => [],
                saveMonitoredRepos: saveReposMock,
                clearRemovedRepositoryIndexData: async () => {},
            },
            database: {
                transaction: async (callback: (trx: never) => Promise<unknown>) => callback({} as never),
            } as never,
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postRepos({
            body: {
                repos_to_monitor: [
                    { name: 'integry/propr', enabled: true },
                ],
            },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 500);
        assert.deepStrictEqual(res.body, {
            error: 'Repository configuration was saved, but publishing the config update notification failed. Persisted config may require a follow-up check.',
            committed: true,
        });
        assert.strictEqual(saveReposMock.mock.calls.length, 1);
    });

    test('postPrimaryProcessingLabels reports committed state when publish fails after save', async () => {
        const saveLabelsMock = mock.fn(async () => true);
        const routes = createConfigRoutes({
            redisClient: {
                set: mock.fn(async () => 'OK'),
                publish: mock.fn(async () => {
                    throw new Error('publish failed');
                }),
                eval: mock.fn(async () => 1),
                lPush: mock.fn(async () => 1),
                lTrim: mock.fn(async () => 'OK'),
            } as never,
            configStore: { savePrimaryProcessingLabels: saveLabelsMock },
        });
        const res = {
            statusCode: 200,
            body: undefined as Record<string, unknown> | undefined,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(payload: Record<string, unknown>) {
                this.body = payload;
                return this;
            },
        };

        await routes.postPrimaryProcessingLabels({
            body: { primary_processing_labels: ['primary'] },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 500);
        assert.deepStrictEqual(res.body, {
            error: 'Primary processing labels were saved, but publishing the config update notification failed. Persisted config may require a follow-up check.',
            committed: true,
        });
        assert.strictEqual(saveLabelsMock.mock.calls.length, 1);
    });

    test('getSettings preserves intentionally empty persisted planner models', async () => {
        const loadSettingsMock = mock.fn(async () => ({
            worker_concurrency: 7,
            github_user_whitelist: ['alice'],
            analysis_model_fast: 'fast-model',
            planner_context_model: '',
            planner_generation_model: '',
        }));
        const loadAutoFollowupScoreThresholdMock = mock.fn(async () => 4);
        const loadAutoResolveMergeConflictsMock = mock.fn(async () => false);
        const loadPrReviewModelMock = mock.fn(async () => 'review-model');
        const loadUltrafixRatingGoalMock = mock.fn(async () => 7);
        const loadUltrafixMaxCyclesMock = mock.fn(async () => 5);
        const loadUltrafixPauseSecondsMock = mock.fn(async () => 60);
        const previousPlannerContextModel = process.env.PLANNER_CONTEXT_MODEL;
        const previousPlannerGenerationModel = process.env.PLANNER_GENERATION_MODEL;
        process.env.PLANNER_CONTEXT_MODEL = 'env-context';
        process.env.PLANNER_GENERATION_MODEL = 'env-generation';

        try {
            const routes = createConfigRoutes({
                redisClient: {} as never,
                configStore: {
                    loadSettings: loadSettingsMock,
                    loadModelReasoningLevel: async () => '',
                    loadAutoFollowupScoreThreshold: loadAutoFollowupScoreThresholdMock,
                    loadAutoResolveMergeConflicts: loadAutoResolveMergeConflictsMock,
                    loadPrReviewModel: loadPrReviewModelMock,
                    loadUltrafixRatingGoal: loadUltrafixRatingGoalMock,
                    loadUltrafixMaxCycles: loadUltrafixMaxCyclesMock,
                    loadUltrafixPauseSeconds: loadUltrafixPauseSecondsMock,
                },
            });
            const res = {
                payload: undefined as Record<string, unknown> | undefined,
                json(body: Record<string, unknown>) {
                    this.payload = body;
                    return this;
                },
                status(_code: number) {
                    return this;
                },
            };

            await routes.getSettings({} as never, res as never);

            assert.deepStrictEqual(res.payload, {
                default_agent_alias: undefined,
                worker_concurrency: 7,
                github_user_whitelist: ['alice'],
                analysis_model_fast: 'fast-model',
                planner_context_model: '',
                planner_generation_model: '',
                pr_review_prompt: '',
                auto_followup_score_threshold: 4,
                auto_resolve_merge_conflicts: false,
                model_reasoning_level: '',
                pr_review_model: 'review-model',
                ultrafix_rating_goal: 7,
                ultrafix_max_cycles: 5,
                ultrafix_pause_seconds: 60,
            });
        } finally {
            if (previousPlannerContextModel === undefined) {
                delete process.env.PLANNER_CONTEXT_MODEL;
            } else {
                process.env.PLANNER_CONTEXT_MODEL = previousPlannerContextModel;
            }
            if (previousPlannerGenerationModel === undefined) {
                delete process.env.PLANNER_GENERATION_MODEL;
            } else {
                process.env.PLANNER_GENERATION_MODEL = previousPlannerGenerationModel;
            }
        }
    });
});
