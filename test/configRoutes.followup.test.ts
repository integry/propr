import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { applyAgentsUpdate } from '../packages/api/routes/configRoutesAgents.ts';
import { saveSettingsWithRollback } from '../packages/api/routes/configRoutes.ts';

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
});
