import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import * as configManager from '../packages/core/src/index.ts';
import { applyAgentsUpdate, createAgentsRoutes } from '../packages/api/routes/configRoutesAgents.ts';
import { normalizeAgentsConfig } from '../packages/api/routes/configHelpers.ts';
import { queueResummarizationForAllRepos, withConfigLock } from '../packages/api/routes/configHelpers.ts';
import { createConfigRoutes } from '../packages/api/routes/configRoutes.ts';
import { saveSettingsWithRollback } from '../packages/api/routes/configRoutesSettings.ts';
import { appendClaudeUserMessageEvents, parseClaudeOutputToConversationResult, parseCodexOutputToConversationResult } from '../packages/api/routes/liveDetailsCodexParser.ts';
import { parseOpenCodeOutputToConversationResult } from '../packages/api/routes/liveDetailsOpenCodeParser.ts';
import {
    detectStoredOutputFormat,
    findLatestHistoryEntryWithSessionId,
    parseStoredOutputContent,
} from '../packages/api/routes/liveDetailsRoutes.ts';
import { parseRedisOutput } from '../packages/api/services/redisOutputParser.ts';

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
        });

        assert.strictEqual(result.status, 500);
        assert.deepStrictEqual(currentSettings, {
            default_agent_alias: 'old-default',
            worker_concurrency: 5,
            keep: 'unchanged',
        });
        assert.deepStrictEqual(result.body, {
            error: 'Failed to save "auto_followup_score_threshold". Earlier changes were rolled back.',
            rolled_back: ['general'],
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
            registry,
        });

        assert.strictEqual(result.status, 500);
        assert.deepStrictEqual(result.body, {
            error: 'Failed to apply committed agent configuration to the live registry, and automatic rollback did not complete. Persisted config may be out of sync with the live registry.',
            out_of_sync: true,
        });
    });

    test('applyAgentsUpdate restores the previous default alias when settings save fails after agents persist', async () => {
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

        await assert.rejects(async () => applyAgentsUpdate({
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
            registry,
        }));

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
        const resolveVersionMock = mock.method(configManager, 'resolveVersion', async () => {
            assert.strictEqual(lockAcquired, false);
            return '1.2.3';
        });

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
        const resolveVersionMock = mock.method(configManager, 'resolveVersion', async () => {
            throw new Error('network timeout');
        });

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
            error: "Failed to resolve version for agent 'new-default': network timeout",
        });
        assert.strictEqual(redisClient.set.mock.calls.length, 0);
        assert.strictEqual(resolveVersionMock.mock.calls.length, 1);
    });

    test('postAgents reports internal agent image derivation failures as server errors', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
        };
        const computeContentHashMock = mock.method(configManager, 'computeContentHash', () => {
            throw new Error('hash generation failed');
        });

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
            error: "Failed to resolve version for agent 'new-default': hash generation failed",
        });
        assert.strictEqual(redisClient.set.mock.calls.length, 0);
        computeContentHashMock.mock.restore();
    });

    test('postAgents rejects malformed cliVersion fields before version resolution or lock acquisition', async () => {
        const redisClient = {
            set: mock.fn(async () => 'OK'),
        };
        const resolveVersionMock = mock.method(configManager, 'resolveVersion', async () => '1.2.3');
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
        const routes = createConfigRoutes({ redisClient: {} as never });
        const autoFollowupMock = mock.method(configManager, 'loadAutoFollowupScoreThreshold', async () => '7' as never);
        const autoResolveMock = mock.method(configManager, 'loadAutoResolveMergeConflicts', async () => false);
        const prReviewModelMock = mock.method(configManager, 'loadPrReviewModel', async () => '');
        const ultrafixGoalMock = mock.method(configManager, 'loadUltrafixRatingGoal', async () => '8' as never);
        const ultrafixCyclesMock = mock.method(configManager, 'loadUltrafixMaxCycles', async () => '9' as never);
        const ultrafixPauseMock = mock.method(configManager, 'loadUltrafixPauseSeconds', async () => '12' as never);
        const settingsMock = mock.method(configManager, 'loadSettings', async () => ({}));
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
            analysis_model_fast: 'claude-3-5-haiku-20241022',
            planner_context_model: '',
            planner_generation_model: '',
            auto_followup_score_threshold: 7,
            auto_resolve_merge_conflicts: false,
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
        const routes = createConfigRoutes({ redisClient: {} as never });
        const autoFollowupMock = mock.method(configManager, 'loadAutoFollowupScoreThreshold', async () => 4);
        const autoResolveMock = mock.method(configManager, 'loadAutoResolveMergeConflicts', async () => true);
        const prReviewModelMock = mock.method(configManager, 'loadPrReviewModel', async () => 'review-model');
        const ultrafixGoalMock = mock.method(configManager, 'loadUltrafixRatingGoal', async () => 8);
        const ultrafixCyclesMock = mock.method(configManager, 'loadUltrafixMaxCycles', async () => 9);
        const ultrafixPauseMock = mock.method(configManager, 'loadUltrafixPauseSeconds', async () => 12);
        const settingsMock = mock.method(configManager, 'loadSettings', async () => ({
            default_agent_alias: 'claude',
            worker_concurrency: 6,
            github_user_whitelist: ['alice'],
            analysis_model_fast: 'fast-model',
            planner_context_model: 'context-model',
            planner_generation_model: 'generation-model',
        }));
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
            auto_followup_score_threshold: 4,
            auto_resolve_merge_conflicts: true,
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
        const routes = createConfigRoutes({ redisClient: {} as never });
        const autoFollowupMock = mock.method(configManager, 'loadAutoFollowupScoreThreshold', async () => 'invalid' as never);
        const autoResolveMock = mock.method(configManager, 'loadAutoResolveMergeConflicts', async () => false);
        const prReviewModelMock = mock.method(configManager, 'loadPrReviewModel', async () => '');
        const ultrafixGoalMock = mock.method(configManager, 'loadUltrafixRatingGoal', async () => 8);
        const ultrafixCyclesMock = mock.method(configManager, 'loadUltrafixMaxCycles', async () => 9);
        const ultrafixPauseMock = mock.method(configManager, 'loadUltrafixPauseSeconds', async () => 12);
        const settingsMock = mock.method(configManager, 'loadSettings', async () => ({}));
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
            analysis_model_fast: 'claude-3-5-haiku-20241022',
            planner_context_model: '',
            planner_generation_model: '',
            auto_followup_score_threshold: 4,
            auto_resolve_merge_conflicts: false,
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

    test('applyAgentsUpdate preserves a submitted dockerImage when version resolution is not requested', async () => {
        const contentHashMock = mock.method(configManager, 'computeContentHash', () => 'abc123');
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
            registry,
        });

        assert.strictEqual(result.status, 200);
        assert.strictEqual((result.body.agents as Array<Record<string, unknown>>)[0]?.dockerImage, 'private.registry/propr/custom:1.2.3');
        assert.strictEqual(contentHashMock.mock.calls.length, 0);
        contentHashMock.mock.restore();
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
            },
        ] as never);

        assert.deepStrictEqual(normalized[0]?.supportedModels, ['claude-sonnet-4-6', 'claude-opus-4-6']);
        assert.strictEqual(normalized[0]?.alias, 'agent-1');
    });

    test('applyAgentsUpdate accepts agents without dockerImage and derives it server-side', async () => {
        const contentHashMock = mock.method(configManager, 'computeContentHash', () => 'abc123');
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
            registry,
        });

        assert.strictEqual(result.status, 200);
        assert.strictEqual(typeof (result.body.agents as Array<Record<string, unknown>>)[0]?.dockerImage, 'string');
        assert.match(String((result.body.agents as Array<Record<string, unknown>>)[0]?.dockerImage), /^propr\/agent-claude:.*-abc123$/);
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
        const saveReposMock = mock.method(configManager, 'saveMonitoredRepos', async () => true);
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

        assert.strictEqual(result.status, 200);
        assert.deepStrictEqual(result.body, {
            success: true,
            warning: 'Configuration changes were committed, but the update lock was lost afterward. Verify the current configuration before retrying.',
            committed: true,
            lock_lost_after_commit: true,
        });
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
            registry,
        });

        assert.strictEqual(result.status, 200);
        assert.deepStrictEqual(result.body, {
            success: true,
            agents: currentAgents,
        });
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
            { type: 'thought', content: 'First answer', timestamp: '2026-05-05T00:00:00.000Z' },
            { type: 'thought', content: 'Second answer', timestamp: '2026-05-05T00:00:02.000Z' },
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
            { type: 'thought', content: 'Done', timestamp: '2026-05-05T00:00:02.000Z' },
        ]);
    });

    test('parseOpenCodeOutputToConversationResult avoids duplicate aggregate and part text', () => {
        const result = parseOpenCodeOutputToConversationResult(
            '{"type":"message","sessionID":"session-a","message":{"role":"assistant","content":"Duplicated","parts":[{"type":"text","text":"Duplicated"}]}}\n'
        );

        assert.deepStrictEqual(result?.events, [
            { type: 'thought', content: 'Duplicated', timestamp: result?.events[0].timestamp },
        ]);
    });

    test('parseOpenCodeOutputToConversationResult avoids duplicate top-level and message text', () => {
        const result = parseOpenCodeOutputToConversationResult(
            '{"type":"message","sessionID":"session-a","part":{"type":"text","text":"Duplicated"},"message":{"role":"assistant","content":"Duplicated"}}\n'
        );

        assert.deepStrictEqual(result?.events, [
            { type: 'thought', content: 'Duplicated', timestamp: result?.events[0].timestamp },
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
            { type: 'thought', content: 'OpenCode says hi', timestamp: parsed.parsed?.events[0].timestamp },
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
                input_tokens: 15,
                output_tokens: 4,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
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
        const savePrLabelMock = mock.method(configManager, 'savePrLabel', async (_value: string) => true);
        const redisClient = {
            set: mock.fn(async () => 'OK'),
            eval: mock.fn(async () => 1),
            publish: mock.fn(async () => 1),
            lPush: mock.fn(async () => 1),
            lTrim: mock.fn(async () => 1),
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
        savePrLabelMock.mock.restore();
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
        const saveKeywordsMock = mock.method(configManager, 'saveFollowupKeywords', async (_value: string[]) => true);
        const redisClient = {
            set: mock.fn(async () => 'OK'),
            eval: mock.fn(async () => 1),
            publish: mock.fn(async () => 1),
            lPush: mock.fn(async () => 1),
            lTrim: mock.fn(async () => 1),
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

        await routes.postFollowupKeywords({
            body: { followup_keywords: ['  bug  ', 'bug', 'feature', '   '] },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, {
            success: true,
            followup_keywords: ['bug', 'feature'],
        });
        assert.deepStrictEqual(saveKeywordsMock.mock.calls[0].arguments[0], ['bug', 'feature']);
        saveKeywordsMock.mock.restore();
    });

    test('postFollowupKeywords reports committed state when publish fails after save', async () => {
        const saveKeywordsMock = mock.method(configManager, 'saveFollowupKeywords', async (_value: string[]) => true);
        const redisClient = {
            set: mock.fn(async () => 'OK'),
            eval: mock.fn(async () => 1),
            publish: mock.fn(async () => {
                throw new Error('publish failed');
            }),
            lPush: mock.fn(async () => 1),
            lTrim: mock.fn(async () => 1),
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

        await routes.postFollowupKeywords({
            body: { followup_keywords: ['bug'] },
        } as never, res as never);

        assert.strictEqual(res.statusCode, 500);
        assert.deepStrictEqual(res.body, {
            error: 'Follow-up keywords were saved, but publishing the config update notification failed. Persisted config may require a follow-up check.',
            committed: true,
        });
        assert.strictEqual(saveKeywordsMock.mock.calls.length, 1);
        saveKeywordsMock.mock.restore();
    });

    test('postFollowupKeywords preserves committed lock-loss warnings when the lock is lost after save', async () => {
        const redisState = new Map<string, string>();
        const saveKeywordsMock = mock.method(configManager, 'saveFollowupKeywords', async (_value: string[]) => true);
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

        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, {
            success: true,
            followup_keywords: ['bug'],
            warning: 'Configuration changes were committed, but the update lock was lost afterward. Verify the current configuration before retrying.',
            committed: true,
            lock_lost_after_commit: true,
        });
        assert.strictEqual(redisState.get('config:keywords:lock'), 'someone-else');
        saveKeywordsMock.mock.restore();
    });

    test('postFollowupKeywords reports lock loss instead of a committed save when publish fails before completion', async () => {
        const redisState = new Map<string, string>();
        const saveKeywordsMock = mock.method(configManager, 'saveFollowupKeywords', async (_value: string[]) => true);
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
        saveKeywordsMock.mock.restore();
    });

    test('queueResummarizationForAllRepos uses enabled raw repo names when scheduling jobs', async () => {
        const loadReposMock = mock.method(configManager, 'loadMonitoredReposRaw', async () => ([
            { id: '1', name: 'acme/alpha', enabled: true },
            { id: '2', name: 'acme/beta', enabled: false },
            { id: '3', name: 'acme/gamma', enabled: true },
        ]));
        const octokitMock = mock.method(configManager, 'getAuthenticatedOctokit', async () => ({
            auth: async () => ({ token: 'test-token' }),
        } as never));
        const ensureRepoClonedMock = mock.method(configManager, 'ensureRepoCloned', async ({ owner, repoName }: { owner: string; repoName: string }) => `/tmp/${owner}-${repoName}`);
        const fetchLatestChangesMock = mock.method(configManager, 'fetchLatestChanges', async () => ({ success: true }));
        const getRepoUrlMock = mock.method(configManager, 'getRepoUrl', ({ repoOwner, repoName }: { repoOwner: string; repoName: string }) => `https://example.com/${repoOwner}/${repoName}.git`);
        const queueAdds: Array<{ repository: string }> = [];
        const getIndexingQueueMock = mock.method(configManager, 'getIndexingQueue', async () => ({
            getJobs: async () => [],
            add: async (_name: string, data: { repository: string }) => {
                queueAdds.push({ repository: data.repository });
            },
        } as never));

        try {
            const queued = await queueResummarizationForAllRepos();
            assert.strictEqual(queued, 2);
            assert.deepStrictEqual(queueAdds, [
                { repository: 'acme/alpha' },
                { repository: 'acme/gamma' },
            ]);
        } finally {
            loadReposMock.mock.restore();
            octokitMock.mock.restore();
            ensureRepoClonedMock.mock.restore();
            fetchLatestChangesMock.mock.restore();
            getRepoUrlMock.mock.restore();
            getIndexingQueueMock.mock.restore();
        }
    });

    test('postRepos reports committed state when publish fails after save', async () => {
        const saveReposMock = mock.method(configManager, 'saveMonitoredRepos', async () => true);
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
        saveReposMock.mock.restore();
    });

    test('postPrimaryProcessingLabels reports committed state when publish fails after save', async () => {
        const saveLabelsMock = mock.method(configManager, 'savePrimaryProcessingLabels', async () => true);
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
        saveLabelsMock.mock.restore();
    });

    test('getSettings preserves intentionally empty persisted planner models', async () => {
        const loadSettingsMock = mock.method(configManager, 'loadSettings', async () => ({
            worker_concurrency: 7,
            github_user_whitelist: ['alice'],
            analysis_model_fast: 'fast-model',
            planner_context_model: '',
            planner_generation_model: '',
        }));
        const loadAutoFollowupScoreThresholdMock = mock.method(configManager, 'loadAutoFollowupScoreThreshold', async () => 4);
        const loadAutoResolveMergeConflictsMock = mock.method(configManager, 'loadAutoResolveMergeConflicts', async () => false);
        const loadPrReviewModelMock = mock.method(configManager, 'loadPrReviewModel', async () => 'review-model');
        const loadUltrafixRatingGoalMock = mock.method(configManager, 'loadUltrafixRatingGoal', async () => 7);
        const loadUltrafixMaxCyclesMock = mock.method(configManager, 'loadUltrafixMaxCycles', async () => 5);
        const loadUltrafixPauseSecondsMock = mock.method(configManager, 'loadUltrafixPauseSeconds', async () => 60);
        const previousPlannerContextModel = process.env.PLANNER_CONTEXT_MODEL;
        const previousPlannerGenerationModel = process.env.PLANNER_GENERATION_MODEL;
        process.env.PLANNER_CONTEXT_MODEL = 'env-context';
        process.env.PLANNER_GENERATION_MODEL = 'env-generation';

        try {
            const routes = createConfigRoutes({ redisClient: {} as never });
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
                auto_followup_score_threshold: 4,
                auto_resolve_merge_conflicts: false,
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
            loadSettingsMock.mock.restore();
            loadAutoFollowupScoreThresholdMock.mock.restore();
            loadAutoResolveMergeConflictsMock.mock.restore();
            loadPrReviewModelMock.mock.restore();
            loadUltrafixRatingGoalMock.mock.restore();
            loadUltrafixMaxCyclesMock.mock.restore();
            loadUltrafixPauseSecondsMock.mock.restore();
        }
    });
});
