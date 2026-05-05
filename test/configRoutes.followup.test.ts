import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import * as configManager from '../packages/core/src/index.ts';
import { applyAgentsUpdate, createAgentsRoutes } from '../packages/api/routes/configRoutesAgents.ts';
import { withConfigLock } from '../packages/api/routes/configHelpers.ts';
import { createConfigRoutes } from '../packages/api/routes/configRoutes.ts';
import { saveSettingsWithRollback } from '../packages/api/routes/configRoutesSettings.ts';
import { appendClaudeUserMessageEvents, parseClaudeOutputToConversationResult, parseCodexOutputToConversationResult } from '../packages/api/routes/liveDetailsCodexParser.ts';
import {
    detectStoredOutputFormat,
    findLatestHistoryEntryWithSessionId,
    parseStoredOutputContent,
} from '../packages/api/routes/liveDetailsRoutes.ts';

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
            error: 'Failed to apply agent configuration to the live registry, and automatic rollback did not complete. Persisted config may be out of sync with the live registry.',
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
});
