import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_GOAL_CONTAINER_RETENTION,
    buildGoalContainerLayout,
} from '../src/agents/goalSession/GoalContainerSupervisor.js';
import {
    GoalSessionContractError,
    assertCredentialFreeRecoveryMetadata,
} from '../src/agents/goalSession/GoalSessionSupervisor.js';

const base = '/var/lib/propr/goal-runtime';
const execution = {
    goalId: 'goal-one',
    sessionId: 'session-one',
    controllerEpoch: 3,
    turnId: 'turn-one',
    executionId: 'execution-one',
    attemptId: 'attempt-one',
};

test('container resources are stable within a goal session and isolated across goals', () => {
    const first = buildGoalContainerLayout(base, execution);
    const nextTurn = buildGoalContainerLayout(base, { ...execution, turnId: 'turn-two', attemptId: 'attempt-two' });
    const otherGoal = buildGoalContainerLayout(base, { ...execution, goalId: 'goal-two' });

    assert.equal(first.providerHome, nextTurn.providerHome);
    assert.equal(first.sessionRoot, nextTurn.sessionRoot);
    assert.notEqual(first.executionId, nextTurn.executionId);
    assert.notEqual(first.sessionRoot, otherGoal.sessionRoot);
    assert.ok(first.providerHome.startsWith(`${base}/goals/`));
    assert.match(first.containerName, /^propr-goal-[a-f0-9-]+$/);
});

test('terminal container retention is explicit and keeps failures longer', () => {
    assert.equal(DEFAULT_GOAL_CONTAINER_RETENTION.succeededMs, 24 * 60 * 60 * 1000);
    assert.equal(DEFAULT_GOAL_CONTAINER_RETENTION.cancelledMs, 24 * 60 * 60 * 1000);
    assert.equal(DEFAULT_GOAL_CONTAINER_RETENTION.failedMs, 7 * 24 * 60 * 60 * 1000);
});

test('credential-like recovery metadata is rejected before persistence', () => {
    assert.doesNotThrow(() => assertCredentialFreeRecoveryMetadata({ checkpoint: 'cp-1', cursor: 5 }));
    assert.throws(
        () => assertCredentialFreeRecoveryMetadata({ checkpoint: 'cp-1', api_token: 'must-not-persist' }),
        (error: unknown) => error instanceof GoalSessionContractError
            && error.code === 'RECOVERY_METADATA_CONTAINS_CREDENTIAL',
    );
});
