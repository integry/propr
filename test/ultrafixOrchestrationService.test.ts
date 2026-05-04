import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    getUltrafixStateKey,
    createDefaultState,
    determineInitialAction,
    determineNextAction,
    saveState,
    loadState,
    clearState,
    startLoop,
    recordAction,
    stopLoop,
    type UltrafixLoopState,
    type StartLoopOptions,
} from '../src/jobs/ultrafixOrchestrationService.js';

// --- Mock Redis ---

function createMockRedis() {
    const store = new Map<string, string>();
    return {
        store,
        async get(key: string) { return store.get(key) ?? null; },
        async set(key: string, value: string) { store.set(key, value); return 'OK'; },
        async del(key: string) { store.delete(key); return 1; },
    };
}

// --- Key format ---

describe('getUltrafixStateKey', () => {
    test('produces the expected key format', () => {
        assert.strictEqual(
            getUltrafixStateKey('acme', 'web', 42),
            'ultrafix:state:acme:web:42',
        );
    });

    test('different PRs produce different keys', () => {
        const k1 = getUltrafixStateKey('owner', 'repo', 1);
        const k2 = getUltrafixStateKey('owner', 'repo', 2);
        assert.notStrictEqual(k1, k2);
    });
});

// --- createDefaultState ---

describe('createDefaultState', () => {
    test('applies defaults when no optional fields provided', () => {
        const state = createDefaultState({ owner: 'o', repo: 'r', pr: 1 });
        assert.strictEqual(state.owner, 'o');
        assert.strictEqual(state.repo, 'r');
        assert.strictEqual(state.pr, 1);
        assert.strictEqual(state.goal, 7);
        assert.strictEqual(state.maxCycles, 5);
        assert.strictEqual(state.pauseSeconds, 60);
        assert.strictEqual(state.reviewModel, '');
        assert.strictEqual(state.cycleCount, 0);
        assert.strictEqual(state.reviewCount, 0);
        assert.strictEqual(state.fixCount, 0);
        assert.strictEqual(state.lastAction, null);
        assert.strictEqual(state.lastActionTimestamp, null);
        assert.strictEqual(state.active, true);
    });

    test('respects overrides', () => {
        const state = createDefaultState({
            owner: 'o', repo: 'r', pr: 5,
            goal: 9, maxCycles: 10, pauseSeconds: 30, reviewModel: 'claude-opus-4-6',
        });
        assert.strictEqual(state.goal, 9);
        assert.strictEqual(state.maxCycles, 10);
        assert.strictEqual(state.pauseSeconds, 30);
        assert.strictEqual(state.reviewModel, 'claude-opus-4-6');
    });
});

// --- determineInitialAction ---

describe('determineInitialAction', () => {
    test('returns fix when there are pending reviews', () => {
        assert.strictEqual(determineInitialAction(true), 'fix');
    });

    test('returns review when there are no pending reviews', () => {
        assert.strictEqual(determineInitialAction(false), 'review');
    });
});

// --- determineNextAction ---

describe('determineNextAction', () => {
    function makeState(overrides: Partial<UltrafixLoopState> = {}): UltrafixLoopState {
        return {
            owner: 'o', repo: 'r', pr: 1,
            goal: 7, maxCycles: 5, pauseSeconds: 60,
            reviewModel: '', cycleCount: 0, reviewCount: 0, fixCount: 0,
            lastAction: null, lastActionTimestamp: null,
            active: true,
            ...overrides,
        };
    }

    test('returns null action when loop is inactive', () => {
        const decision = determineNextAction(makeState({ active: false }), null);
        assert.strictEqual(decision.action, null);
        assert.ok(decision.reason.includes('inactive'));
    });

    test('stops when goal is met', () => {
        const decision = determineNextAction(makeState({ goal: 7 }), 8);
        assert.strictEqual(decision.action, null);
        assert.ok(decision.reason.includes('Goal met'));
    });

    test('stops when score exactly meets goal', () => {
        const decision = determineNextAction(makeState({ goal: 7 }), 7);
        assert.strictEqual(decision.action, null);
        assert.ok(decision.reason.includes('Goal met'));
    });

    test('stops when max cycles reached', () => {
        const decision = determineNextAction(makeState({ maxCycles: 3, cycleCount: 3, reviewCount: 3, fixCount: 3, lastAction: 'fix' }), 5);
        assert.strictEqual(decision.action, null);
        assert.ok(decision.reason.includes('Max cycles'));
    });

    test('allows the last fix step when reviews have already hit the limit', () => {
        const decision = determineNextAction(makeState({
            maxCycles: 5,
            cycleCount: 4,
            reviewCount: 5,
            fixCount: 4,
            lastAction: 'review',
        }), 4);
        assert.strictEqual(decision.action, 'fix');
    });

    test('allows the last review step when fixes have already hit the limit', () => {
        const decision = determineNextAction(makeState({
            maxCycles: 5,
            cycleCount: 4,
            reviewCount: 4,
            fixCount: 5,
            lastAction: 'fix',
        }), null);
        assert.strictEqual(decision.action, 'review');
    });

    test('returns review when no previous action', () => {
        const decision = determineNextAction(makeState(), null);
        assert.strictEqual(decision.action, 'review');
    });

    test('returns fix after review', () => {
        const decision = determineNextAction(makeState({ lastAction: 'review' }), 5);
        assert.strictEqual(decision.action, 'fix');
    });

    test('returns review after fix', () => {
        const decision = determineNextAction(makeState({ lastAction: 'fix', cycleCount: 1 }), 5);
        assert.strictEqual(decision.action, 'review');
    });

    test('continues when score is below goal', () => {
        const decision = determineNextAction(makeState({ lastAction: 'review', goal: 8 }), 6);
        assert.strictEqual(decision.action, 'fix');
    });

    test('continues when score is null (no score yet)', () => {
        const decision = determineNextAction(makeState({ lastAction: 'review' }), null);
        assert.strictEqual(decision.action, 'fix');
    });
});

// --- Redis persistence (saveState / loadState / clearState) ---

describe('Redis persistence', () => {
    test('save and load round-trips state', async () => {
        const redis = createMockRedis();
        const state = createDefaultState({ owner: 'acme', repo: 'web', pr: 10 });
        state.cycleCount = 2;
        state.reviewCount = 2;
        state.fixCount = 2;
        state.lastAction = 'fix';
        state.lastActionTimestamp = '2026-04-28T20:00:00Z';

        await saveState(redis as any, state);
        const loaded = await loadState(redis as any, 'acme', 'web', 10);

        assert.deepStrictEqual(loaded, state);
    });

    test('loadState returns null for missing key', async () => {
        const redis = createMockRedis();
        const loaded = await loadState(redis as any, 'no', 'exist', 1);
        assert.strictEqual(loaded, null);
    });

    test('clearState removes the key', async () => {
        const redis = createMockRedis();
        const state = createDefaultState({ owner: 'o', repo: 'r', pr: 1 });
        await saveState(redis as any, state);
        await clearState(redis as any, 'o', 'r', 1);
        const loaded = await loadState(redis as any, 'o', 'r', 1);
        assert.strictEqual(loaded, null);
    });
});

// --- startLoop ---

describe('startLoop', () => {
    test('writes state to Redis and returns initial action review', async () => {
        const redis = createMockRedis();
        const { state, initialAction } = await startLoop(redis as any, {
            owner: 'acme', repo: 'web', pr: 5, goal: 8,
        }, false);

        assert.strictEqual(initialAction, 'review');
        assert.strictEqual(state.active, true);
        assert.strictEqual(state.goal, 8);
        assert.strictEqual(state.lastAction, 'review');
        assert.ok(state.lastActionTimestamp);

        // Verify persisted
        const loaded = await loadState(redis as any, 'acme', 'web', 5);
        assert.deepStrictEqual(loaded, state);
    });

    test('returns fix as initial action when pending reviews exist', async () => {
        const redis = createMockRedis();
        const { initialAction } = await startLoop(redis as any, {
            owner: 'o', repo: 'r', pr: 1,
        }, true);

        assert.strictEqual(initialAction, 'fix');
    });
});

// --- recordAction ---

describe('recordAction', () => {
    test('updates state after review (no cycle increment)', async () => {
        const redis = createMockRedis();
        await startLoop(redis as any, { owner: 'o', repo: 'r', pr: 1 }, false);

        const updated = await recordAction(redis as any, { owner: 'o', repo: 'r', pr: 1, action: 'review' });
        assert.ok(updated);
        assert.strictEqual(updated!.lastAction, 'review');
        assert.strictEqual(updated!.cycleCount, 0);
        assert.strictEqual(updated!.reviewCount, 1);
        assert.strictEqual(updated!.fixCount, 0);
    });

    test('increments cycle count after fix', async () => {
        const redis = createMockRedis();
        await startLoop(redis as any, { owner: 'o', repo: 'r', pr: 1 }, false);
        await recordAction(redis as any, { owner: 'o', repo: 'r', pr: 1, action: 'review' });

        const updated = await recordAction(redis as any, { owner: 'o', repo: 'r', pr: 1, action: 'fix' });
        assert.ok(updated);
        assert.strictEqual(updated!.lastAction, 'fix');
        assert.strictEqual(updated!.cycleCount, 1);
        assert.strictEqual(updated!.reviewCount, 1);
        assert.strictEqual(updated!.fixCount, 1);
    });

    test('returns null for non-existent state', async () => {
        const redis = createMockRedis();
        const result = await recordAction(redis as any, { owner: 'no', repo: 'exist', pr: 99, action: 'fix' });
        assert.strictEqual(result, null);
    });
});

// --- stopLoop ---

describe('stopLoop', () => {
    test('marks loop as inactive', async () => {
        const redis = createMockRedis();
        await startLoop(redis as any, { owner: 'o', repo: 'r', pr: 1 }, false);

        const stopped = await stopLoop(redis as any, 'o', 'r', 1);
        assert.ok(stopped);
        assert.strictEqual(stopped!.active, false);

        // Verify persisted
        const loaded = await loadState(redis as any, 'o', 'r', 1);
        assert.strictEqual(loaded!.active, false);
    });

    test('returns null for non-existent state', async () => {
        const redis = createMockRedis();
        const result = await stopLoop(redis as any, 'no', 'exist', 99);
        assert.strictEqual(result, null);
    });
});

// --- Mode transition verification ---

describe('mode transitions', () => {
    test('review -> fix -> review alternation is enforced', () => {
        const state = createDefaultState({ owner: 'o', repo: 'r', pr: 1, goal: 9, maxCycles: 10 });

        // Start: no lastAction → review
        let decision = determineNextAction(state, null);
        assert.strictEqual(decision.action, 'review');

        // After review → fix
        state.lastAction = 'review';
        decision = determineNextAction(state, 5);
        assert.strictEqual(decision.action, 'fix');

        // After fix → review
        state.lastAction = 'fix';
        state.cycleCount = 1;
        decision = determineNextAction(state, 5);
        assert.strictEqual(decision.action, 'review');

        // After review again → fix
        state.lastAction = 'review';
        decision = determineNextAction(state, 6);
        assert.strictEqual(decision.action, 'fix');
    });

    test('fix never follows fix', () => {
        const state = createDefaultState({ owner: 'o', repo: 'r', pr: 1, goal: 9 });
        state.lastAction = 'fix';
        state.cycleCount = 1;
        const decision = determineNextAction(state, 4);
        assert.strictEqual(decision.action, 'review', 'After fix, next must be review');
    });

    test('review never follows review (when score is below goal)', () => {
        const state = createDefaultState({ owner: 'o', repo: 'r', pr: 1, goal: 9 });
        state.lastAction = 'review';
        const decision = determineNextAction(state, 4);
        assert.strictEqual(decision.action, 'fix', 'After review with low score, next must be fix');
    });
});

// --- Serialization round-trip ---

describe('Serialization', () => {
    test('all fields survive JSON round-trip', async () => {
        const redis = createMockRedis();
        const opts: StartLoopOptions = {
            owner: 'integry', repo: 'propr', pr: 1425,
            goal: 9, maxCycles: 10, pauseSeconds: 120, reviewModel: 'claude-opus-4-6',
        };
        const { state } = await startLoop(redis as any, opts, true);

        // Simulate process restart — load from raw JSON
        const raw = redis.store.get(getUltrafixStateKey('integry', 'propr', 1425))!;
        const restored = JSON.parse(raw) as UltrafixLoopState;

        assert.strictEqual(restored.owner, 'integry');
        assert.strictEqual(restored.repo, 'propr');
        assert.strictEqual(restored.pr, 1425);
        assert.strictEqual(restored.goal, 9);
        assert.strictEqual(restored.maxCycles, 10);
        assert.strictEqual(restored.pauseSeconds, 120);
        assert.strictEqual(restored.reviewModel, 'claude-opus-4-6');
        assert.strictEqual(restored.active, true);
        assert.strictEqual(typeof restored.lastActionTimestamp, 'string');
    });
});
