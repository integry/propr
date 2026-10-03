import { after, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ReasoningLevel } from '@propr/shared';
import { resolveAgentModelReasoningLevel, resolveRuntimeModelReasoningLevel } from '../packages/core/src/config/configManagerReasoning.js';
import { createDefaultState } from '../src/jobs/ultrafixOrchestrationService.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => { await closeConnection(); });

const logs: { details: Record<string, unknown>; message: string }[] = [];
beforeEach(() => { logs.length = 0; });
let candidates = ['claude:stronger'];
let failResolution = false;
let failUsage = false;
let enabled = false;
let maxReasoningLevels = 0;
let globalEffort: ReasoningLevel | '' = '';
let usage: { sessionPercent?: number; weeklyPercent?: number } | null = null;
const configs = {
    antigravity: { alias: 'antigravity', type: 'antigravity', enabled: true, supportedModels: ['gemini-3-pro-low', 'gemini-3-pro-high'], modelReasoningLevels: {} as Record<string, ReasoningLevel> },
    codex: { alias: 'codex', type: 'codex', enabled: true, supportedModels: ['base'], modelReasoningLevels: { base: 'high' } as Record<string, ReasoningLevel> },
    claude: { alias: 'claude', type: 'claude', enabled: true, supportedModels: ['stronger'], modelReasoningLevels: { stronger: 'medium' } as Record<string, ReasoningLevel> },
};
await mock.module('@propr/core', { namedExports: {
    logger: { info: (details: Record<string, unknown>, message: string) => logs.push({ details, message }) },
    AgentRegistry: { getInstance: () => ({ ensureInitialized: async () => {}, getAgentByAlias: (alias: keyof typeof configs) => configs[alias] ? ({ config: configs[alias] }) : undefined }) },
    loadUltrafixEscalationSettings: async () => ({ enabled, models: candidates, patience: 1, maxReasoningLevels }),
    loadModelReasoningLevel: async () => globalEffort,
    resolveAgentModelReasoningLevel,
    resolveRuntimeModelReasoningLevel,
    resolveLlmLabel: async (model: string) => ({ agentAlias: model.split(':')[0], model: model.split(':')[1] }),
    resolveConfiguredModel: async (model: string) => { if (failResolution && model.startsWith('claude:')) throw new Error('resolution failed'); return model; },
} });
await mock.module('../packages/core/src/services/syntheticUsageSnapshotProvider.js', { namedExports: {
    AliasSpecificAgentTankSnapshotProvider: class { async getSnapshot() { if (failUsage) throw new Error('monitor unavailable'); return usage; } },
} });
const { resolveUltrafixFixExecution, recordUltrafixEscalationReview } = await import('../src/jobs/ultrafixEscalation.js');

function fixture() {
    let raw = JSON.stringify(createDefaultState({ owner: 'o', repo: 'r', pr: 1 }));
    let acceptSave = true;
    const redis = {
        get: async () => raw,
        eval: async (_script: string, _count: number, ...args: string[]) => { if (!acceptSave) return 0; raw = args[3]; return 1; },
    };
    return { redis: redis as never, read: () => JSON.parse(raw), rejectSaves: () => { acceptSave = false; } };
}

test('off retains model, effort, and exact serialized loop state', async () => {
    enabled = false;
    const f = fixture();
    const before = JSON.stringify(f.read());
    const execution = await resolveUltrafixFixExecution({ redis: f.redis, owner: 'o', repo: 'r', pr: 1, workEpoch: 0, model: 'codex:base', effort: 'xhigh' });
    assert.deepEqual(execution, { model: 'codex:base', effort: 'xhigh' });
    assert.equal(JSON.stringify(f.read()), before);
});

test('N=0 keeps original dial, handoff uses its own effort, and overrides old PR labels', async () => {
    enabled = true; usage = null;
    const f = fixture();
    const input = { redis: f.redis, owner: 'o', repo: 'r', pr: 1, workEpoch: 0, model: 'codex:base', effort: 'xhigh' as const };
    assert.deepEqual(await resolveUltrafixFixExecution(input), { model: 'codex:base', effort: 'xhigh' });
    await recordUltrafixEscalationReview(f.redis, f.read(), 6);
    await recordUltrafixEscalationReview(f.redis, f.read(), 6);
    assert.deepEqual(await resolveUltrafixFixExecution(input), { model: 'claude:stronger', effort: 'medium' });
});

test('near-limit usage skips the candidate; unavailable signal allows handoff', async () => {
    enabled = true;
    for (const [signal, exhausted] of [[{ weeklyPercent: 95 }, true], [null, false]] as const) {
        usage = signal;
        const f = fixture();
        await resolveUltrafixFixExecution({ redis: f.redis, owner: 'o', repo: 'r', pr: 1, workEpoch: 0, model: 'codex:base' });
        await recordUltrafixEscalationReview(f.redis, f.read(), 6);
        await recordUltrafixEscalationReview(f.redis, f.read(), 6);
        assert.equal(f.read().escalation.exhausted, exhausted);
    }
});

test('switching the master toggle off bypasses an existing escalation stage', async () => {
    enabled = true; usage = null;
    const f = fixture();
    const input = { redis: f.redis, owner: 'o', repo: 'r', pr: 1, workEpoch: 0, model: 'codex:base', effort: 'high' as const };
    await resolveUltrafixFixExecution(input);
    await recordUltrafixEscalationReview(f.redis, f.read(), 6);
    await recordUltrafixEscalationReview(f.redis, f.read(), 6);
    enabled = false;
    const before = JSON.stringify(f.read());
    assert.deepEqual(await resolveUltrafixFixExecution(input), { model: 'codex:base', effort: 'high' });
    await recordUltrafixEscalationReview(f.redis, f.read(), 6);
    assert.equal(JSON.stringify(f.read()), before);
});

test('absent and auto effort retain runtime selection until the first explicit step', async t => {
    // These assertions describe our explicit dial, not the runtime's implicit
    // effort. An unknown runtime default cannot establish a downward transition.
    for (const alias of ['codex', 'claude'] as const) {
        for (const source of ['absent', 'global auto', 'model auto', 'override auto'] as const) {
            for (const limit of [0, 1]) {
                await t.test(`${alias}: ${source}, N=${limit}`, async () => {
                    enabled = true; usage = null; maxReasoningLevels = limit;
                    globalEffort = source === 'global auto' ? 'auto' : '';
                    configs.codex.modelReasoningLevels = {};
                    configs.claude.modelReasoningLevels = {};
                    const id = alias === 'codex' ? 'base' : 'stronger';
                    if (source === 'model auto') configs[alias].modelReasoningLevels[id] = 'auto';
                    const effort = source === 'override auto' ? 'auto' as const : undefined;
                    const f = fixture();
                    const input = { redis: f.redis, owner: 'o', repo: 'r', pr: 1, workEpoch: 0, model: `${alias}:${id}`, effort };
                    try {
                        assert.deepEqual(await resolveUltrafixFixExecution(input), { model: input.model, effort });
                        assert.equal(f.read().escalation.current.effort, undefined);
                        assert.ok(!f.read().escalation.current.levels.includes('auto'));
                        await recordUltrafixEscalationReview(f.redis, f.read(), 6);
                        assert.deepEqual(await resolveUltrafixFixExecution(input), { model: input.model, effort });
                        await recordUltrafixEscalationReview(f.redis, f.read(), 6);
                        if (limit === 1) {
                            assert.deepEqual(await resolveUltrafixFixExecution(input), { model: input.model, effort: 'medium' });
                            assert.equal(f.read().escalation.climbs, 1);
                            assert.equal(f.read().escalation.modelIndex, 0);
                        } else {
                            assert.equal(f.read().escalation.modelIndex, 1);
                            assert.equal(f.read().escalation.climbs, 0);
                            assert.equal(f.read().escalation.current.effort, undefined);
                            assert.deepEqual(await resolveUltrafixFixExecution(input), { model: 'claude:stronger', effort: undefined });
                        }
                        // Handoff models also start from an absent/auto setting.
                        if (limit === 1) {
                            await recordUltrafixEscalationReview(f.redis, f.read(), 6);
                            assert.equal(f.read().escalation.modelIndex, 1);
                            assert.equal(f.read().escalation.current.effort, undefined);
                            assert.deepEqual(await resolveUltrafixFixExecution(input), { model: 'claude:stronger', effort: undefined });
                            await recordUltrafixEscalationReview(f.redis, f.read(), 6);
                            assert.deepEqual(await resolveUltrafixFixExecution(input), { model: 'claude:stronger', effort: 'medium' });
                            assert.equal(f.read().escalation.climbs, 1);
                        }
                    } finally {
                        maxReasoningLevels = 0; globalEffort = '';
                        configs.codex.modelReasoningLevels = { base: 'high' };
                        configs.claude.modelReasoningLevels = { stronger: 'medium' };
                    }
                });
            }
        }
    }
});


test('logs persisted reasoning increases and handoffs with PR context and both efforts', async () => {
    enabled = true; usage = null; maxReasoningLevels = 1;
    const f = fixture();
    try {
        await resolveUltrafixFixExecution({ redis: f.redis, owner: 'o', repo: 'r', pr: 1, workEpoch: 0, model: 'codex:base', effort: 'high' });
        await recordUltrafixEscalationReview(f.redis, f.read(), 6);
        assert.equal(logs.length, 0, 'an improving review does not log a transition');
        await recordUltrafixEscalationReview(f.redis, f.read(), 6);
        assert.deepEqual(logs, [{ message: 'Ultrafix escalation: reasoning increased', details: {
            owner: 'o', repo: 'r', pr: 1, workEpoch: 0, score: 6, bestScore: 6,
            fromModel: 'codex:base', toModel: 'codex:base', fromEffort: 'high', toEffort: 'xhigh', climbs: 1, reason: 'plateau',
        } }]);
        await recordUltrafixEscalationReview(f.redis, f.read(), 6);
        assert.deepEqual(logs[1], { message: 'Ultrafix escalation: model handoff', details: {
            owner: 'o', repo: 'r', pr: 1, workEpoch: 0, score: 6, bestScore: 6,
            fromModel: 'codex:base', toModel: 'claude:stronger', fromEffort: 'xhigh', toEffort: 'medium', modelIndex: 1, reason: 'reasoning_limit_reached',
        } });
    } finally { maxReasoningLevels = 0; }
});

test('logs candidate skip reasons, including resolution failures and both usage limits', async t => {
    enabled = true;
    for (const reason of ['agent_unavailable', 'agent_disabled', 'model_unsupported', 'usage_limit_session', 'usage_limit_weekly', 'model_resolution_failed'] as const) {
        await t.test(reason, async () => {
            logs.length = 0;
            usage = reason === 'usage_limit_session' ? { sessionPercent: 90 } : reason === 'usage_limit_weekly' ? { weeklyPercent: 95 } : null;
            candidates = [reason === 'agent_unavailable' ? 'missing:model' : reason === 'model_unsupported' ? 'claude:missing' : 'claude:stronger'];
            configs.claude.enabled = reason !== 'agent_disabled';
            failResolution = reason === 'model_resolution_failed';
            const f = fixture();
            try {
                await resolveUltrafixFixExecution({ redis: f.redis, owner: 'o', repo: 'r', pr: 1, workEpoch: 0, model: 'codex:base' });
                await recordUltrafixEscalationReview(f.redis, f.read(), 6);
                await recordUltrafixEscalationReview(f.redis, f.read(), 6);
                assert.equal(f.read().escalation.exhausted, true);
                assert.equal(logs.length, 1);
                assert.equal(logs[0].message, 'Ultrafix escalation: candidate skipped');
                assert.equal(logs[0].details.candidate, candidates[0]);
                assert.equal(logs[0].details.reason, reason.startsWith('usage_limit') ? 'usage_limit' : reason);
                assert.equal(logs[0].details.pr, 1);
                if (usage) {
                    assert.equal(logs[0].details.sessionPercent, usage.sessionPercent);
                    assert.equal(logs[0].details.weeklyPercent, usage.weeklyPercent);
                }
            } finally { usage = null; candidates = ['claude:stronger']; configs.claude.enabled = true; failResolution = false; }
        });
    }
});

test('logs skips in order before a later handoff, allowing a failed usage monitor', async () => {
    enabled = true; usage = null; failUsage = true;
    candidates = ['missing:model', 'claude:stronger'];
    const f = fixture();
    try {
        await resolveUltrafixFixExecution({ redis: f.redis, owner: 'o', repo: 'r', pr: 1, workEpoch: 0, model: 'codex:base' });
        await recordUltrafixEscalationReview(f.redis, f.read(), 6);
        await recordUltrafixEscalationReview(f.redis, f.read(), 6);
        assert.deepEqual(logs.map(log => log.message), ['Ultrafix escalation: candidate skipped', 'Ultrafix escalation: model handoff']);
        assert.equal(logs[0].details.reason, 'agent_unavailable');
        assert.equal(logs[1].details.toModel, 'claude:stronger');
        assert.equal(logs[1].details.modelIndex, 2);
    } finally { failUsage = false; candidates = ['claude:stronger']; }
});

test('rejected state saves do not report skips or transitions', async t => {
    enabled = true; usage = null;
    for (const path of ['reasoning', 'handoff', 'skip'] as const) {
        await t.test(path, async () => {
            logs.length = 0;
            maxReasoningLevels = path === 'reasoning' ? 1 : 0;
            candidates = path === 'skip' ? ['missing:model'] : ['claude:stronger'];
            const f = fixture();
            try {
                await resolveUltrafixFixExecution({ redis: f.redis, owner: 'o', repo: 'r', pr: 1, workEpoch: 0, model: 'codex:base', effort: 'high' });
                await recordUltrafixEscalationReview(f.redis, f.read(), 6);
                const before = f.read();
                f.rejectSaves();
                assert.equal(await recordUltrafixEscalationReview(f.redis, f.read(), 6), null);
                assert.deepEqual(f.read(), before);
                assert.deepEqual(logs, []);
            } finally { maxReasoningLevels = 0; candidates = ['claude:stronger']; }
        });
    }
});


test('encoded effort changes are logged as reasoning increases with both model IDs', async () => {
    enabled = true; usage = null; maxReasoningLevels = 1;
    const f = fixture();
    try {
        await resolveUltrafixFixExecution({ redis: f.redis, owner: 'o', repo: 'r', pr: 1, workEpoch: 0, model: 'antigravity:gemini-3-pro-low' });
        await recordUltrafixEscalationReview(f.redis, f.read(), 6);
        await recordUltrafixEscalationReview(f.redis, f.read(), 6);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].message, 'Ultrafix escalation: reasoning increased');
        assert.equal(logs[0].details.fromModel, 'antigravity:gemini-3-pro-low');
        assert.equal(logs[0].details.toModel, 'antigravity:gemini-3-pro-high');
        assert.equal(logs[0].details.fromEffort, 'low');
        assert.equal(logs[0].details.toEffort, 'high');
    } finally { maxReasoningLevels = 0; }
});
