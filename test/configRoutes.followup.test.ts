import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { applyAgentsUpdate } from '../packages/api/routes/configRoutesAgents.ts';
import { withConfigLock } from '../packages/api/routes/configHelpers.ts';
import { saveSettingsWithRollback } from '../packages/api/routes/configRoutesSettings.ts';
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
            get: mock.fn(async (key: string) => redisState.get(key) ?? null),
            expire: mock.fn(async (_key: string, _seconds: number) => 1),
            del: mock.fn(async (key: string) => {
                redisState.delete(key);
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
        assert.ok(redisClient.expire.mock.calls.length >= 2);
        assert.strictEqual(redisState.has('config:test:lock'), false);
    });

    test('withConfigLock does not delete a lock that has been replaced by another owner', async () => {
        const redisState = new Map<string, string>();
        const redisClient = {
            set: mock.fn(async (key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
                if (opts.NX && redisState.has(key)) return null;
                redisState.set(key, value);
                return 'OK';
            }),
            get: mock.fn(async (key: string) => redisState.get(key) ?? null),
            expire: mock.fn(async (_key: string, _seconds: number) => 1),
            del: mock.fn(async (key: string) => {
                redisState.delete(key);
                return 1;
            }),
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
});
