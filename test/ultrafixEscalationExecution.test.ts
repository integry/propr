import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ReasoningLevel } from '@propr/shared';
import { resolveAgentModelReasoningLevel, resolveRuntimeModelReasoningLevel } from '../packages/core/src/config/configManagerReasoning.js';
import { createDefaultState } from '../src/jobs/ultrafixOrchestrationService.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => { await closeConnection(); });

let enabled = false;
let maxReasoningLevels = 0;
let globalEffort: ReasoningLevel | '' = '';
let usage: { sessionPercent?: number; weeklyPercent?: number } | null = null;
const configs = {
    codex: { alias: 'codex', type: 'codex', enabled: true, supportedModels: ['base'], modelReasoningLevels: { base: 'high' } as Record<string, ReasoningLevel> },
    claude: { alias: 'claude', type: 'claude', enabled: true, supportedModels: ['stronger'], modelReasoningLevels: { stronger: 'medium' } as Record<string, ReasoningLevel> },
};
await mock.module('@propr/core', { namedExports: {
    AgentRegistry: { getInstance: () => ({ ensureInitialized: async () => {}, getAgentByAlias: (alias: keyof typeof configs) => ({ config: configs[alias] }) }) },
    loadUltrafixEscalationSettings: async () => ({ enabled, models: ['claude:stronger'], patience: 1, maxReasoningLevels }),
    loadModelReasoningLevel: async () => globalEffort,
    resolveAgentModelReasoningLevel,
    resolveRuntimeModelReasoningLevel,
    resolveLlmLabel: async (model: string) => ({ agentAlias: model.split(':')[0], model: model.split(':')[1] }),
    resolveConfiguredModel: async (model: string) => model,
} });
await mock.module('../packages/core/src/services/syntheticUsageSnapshotProvider.js', { namedExports: {
    AliasSpecificAgentTankSnapshotProvider: class { async getSnapshot() { return usage; } },
} });
const { resolveUltrafixFixExecution, recordUltrafixEscalationReview } = await import('../src/jobs/ultrafixEscalation.js');

function fixture() {
    let raw = JSON.stringify(createDefaultState({ owner: 'o', repo: 'r', pr: 1 }));
    const redis = {
        get: async () => raw,
        eval: async (_script: string, _count: number, ...args: string[]) => { raw = args[3]; return 1; },
    };
    return { redis: redis as never, read: () => JSON.parse(raw) };
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
