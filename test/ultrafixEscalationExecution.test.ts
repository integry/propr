import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultState } from '../src/jobs/ultrafixOrchestrationService.js';

let enabled = false;
let usage: { sessionPercent?: number; weeklyPercent?: number } | null = null;
const configs = {
    codex: { alias: 'codex', type: 'codex', enabled: true, supportedModels: ['base'], modelReasoningLevels: { base: 'high' } },
    claude: { alias: 'claude', type: 'claude', enabled: true, supportedModels: ['stronger'], modelReasoningLevels: { stronger: 'medium' } },
};
await mock.module('@propr/core', { namedExports: {
    AgentRegistry: { getInstance: () => ({ ensureInitialized: async () => {}, getAgentByAlias: (alias: keyof typeof configs) => ({ config: configs[alias] }) }) },
    loadUltrafixEscalationSettings: async () => ({ enabled, models: ['claude:stronger'], patience: 1, maxReasoningLevels: 0 }),
    loadModelReasoningLevel: async () => '',
    resolveAgentModelReasoningLevel: (levels: Record<string, string>, model: string) => levels[model],
    resolveRuntimeModelReasoningLevel: (_type: string, effort: string) => effort || null,
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
