import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import {
  goalBlockerSupport,
  projectGoalAttention,
  type GoalBlockerGoalState,
  type GoalBlockerRow,
} from '../packages/shared/src/goalBlockers.ts';
import { CodexProviderRequests, codexServerRequestBlocker, codexUserInputResponse } from '../packages/core/src/agents/impl/codexAppServerBlockers.ts';
import type { AppServerConnection } from '../packages/core/src/agents/impl/codexAppServerConnection.ts';
import type { AgentTaskOptions } from '../packages/core/src/agents/types.ts';
import { closeGoalBlockers, recordGoalBlocker, resolveGoalBlocker } from '../packages/core/src/goals/goalBlockerStore.ts';

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

/** Recorded Codex App Server 0.160 server requests (`codex app-server generate-ts`). */
const fixtures = {
  userInput: {
    id: 0, method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-7', isBlocking: true, autoResolutionMs: null,
      questions: [{
        id: 'db', header: 'Database', question: 'Which database should the migration target?', isOther: true, isSecret: false,
        options: [{ label: 'Postgres', description: 'Production' }, { label: 'SQLite', description: 'Local' }],
      }],
    },
  },
  multiQuestionInput: {
    id: 9, method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-12', isBlocking: true,
      questions: [
        { id: 'db', header: 'Database', question: 'Which database should the migration target?', isOther: true, isSecret: false, options: null },
        { id: 'region', header: 'Region', question: 'Which region should it deploy to?', isOther: true, isSecret: false, options: null },
      ],
    },
  },
  secretInput: {
    id: 1, method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-8', isBlocking: true,
      questions: [{ id: 'token', header: 'Token', question: 'Paste the deploy token', isOther: false, isSecret: true, options: null }],
    },
  },
  nonBlockingInput: {
    id: 2, method: 'item/tool/requestUserInput',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-9', isBlocking: false,
      questions: [{ id: 'q', header: '', question: 'Optional preference?', isOther: false, isSecret: false, options: null }] },
  },
  commandApproval: {
    id: 'srv-3', method: 'item/commandExecution/requestApproval',
    params: {
      kind: 'command', threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-10', startedAtMs: 1, environmentId: null,
      command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" https://example.test',
      reason: 'Needs network access', cwd: '/home/node/workspace',
    },
  },
  fileApproval: {
    id: 4, method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-11', startedAtMs: 1, reason: null, grantRoot: '/etc' },
  },
  legacyExecApproval: {
    id: 5, method: 'execCommandApproval',
    params: { conversationId: 'thread-1', callId: 'call-1', approvalId: null, command: ['rm', '-rf', 'dist'], cwd: '/w', reason: null, parsedCmd: [] },
  },
  elicitation: {
    id: 6, method: 'mcpServer/elicitation/request',
    params: { threadId: 'thread-1', turnId: 'turn-1', serverName: 'docs', mode: 'url', _meta: null,
      message: 'Sign in to continue', url: 'https://login.example/?token=secret', elicitationId: 'e-1' },
  },
};

describe('Codex App Server provider event fixtures', () => {
  test('an explicit user-input request is one answerable question with its actual prompt', () => {
    const blocker = codexServerRequestBlocker(fixtures.userInput)!;
    assert.equal(blocker.report.category, 'question');
    assert.equal(blocker.report.summary, 'Which database should the migration target?');
    assert.equal(blocker.report.requestKey, 'codex:thread-1:turn-1:item-7:user-input');
    assert.equal(blocker.report.source, 'codex_app_server:item/tool/requestUserInput');
    assert.deepEqual(blocker.report.questions, [{
      id: 'db', header: 'Database', question: 'Which database should the migration target?', options: ['Postgres', 'SQLite'], confidential: false,
    }]);
    assert.deepEqual(blocker.report.responseActions, ['send_input', 'pause', 'cancel']);
    assert.deepEqual(blocker.answerQuestionIds, ['db']);
    assert.deepEqual(codexUserInputResponse(blocker.answerQuestionIds, 'Postgres'), { answers: { db: { answers: ['Postgres'] } } });
    // A repeated event keeps the same identity, so it cannot create a second blocker.
    assert.equal(codexServerRequestBlocker({ ...fixtures.userInput, id: 99 })!.report.requestKey, blocker.report.requestKey);
  });

  test('a secret question is reported but handed off rather than answered through persisted input', () => {
    const blocker = codexServerRequestBlocker(fixtures.secretInput)!;
    assert.deepEqual(blocker.report.responseActions, ['pause', 'cancel']);
    assert.deepEqual(blocker.answerQuestionIds, []);
  });

  test('a request asking several questions is handed off rather than given one answer for all', () => {
    const blocker = codexServerRequestBlocker(fixtures.multiQuestionInput)!;
    assert.equal(blocker.report.summary, '2 questions: Which database should the migration target?');
    assert.equal(blocker.report.questions?.length, 2);
    assert.deepEqual(blocker.report.responseActions, ['pause', 'cancel']);
    assert.deepEqual(blocker.answerQuestionIds, []);
    assert.throws(() => codexUserInputResponse(['db', 'region'], 'Postgres'), /exactly one/);
    // A malformed second question is still a question ProPR cannot answer for the operator.
    const partly = codexServerRequestBlocker({ ...fixtures.multiQuestionInput, params: { ...fixtures.multiQuestionInput.params,
      questions: [fixtures.multiQuestionInput.params.questions[0], { id: 'region', question: '' }] } })!;
    assert.deepEqual(partly.answerQuestionIds, []);
  });

  test('approvals are reported with a redacted reason and never offer an approve action', () => {
    const command = codexServerRequestBlocker(fixtures.commandApproval)!;
    assert.equal(command.report.category, 'approval');
    assert.deepEqual(command.report.responseActions, ['pause', 'cancel']);
    assert.match(command.report.summary, /^Approve command: curl/);
    assert.match(command.report.summary, /Needs network access$/);
    assert.doesNotMatch(command.report.summary, /abcdefghijklmnopqrstuvwxyz0123456789/);
    assert.equal(codexServerRequestBlocker(fixtures.fileApproval)!.report.summary, 'Approve file changes under /etc');
    const legacy = codexServerRequestBlocker(fixtures.legacyExecApproval)!;
    assert.equal(legacy.report.summary, 'Approve command: rm -rf dist');
    assert.equal(legacy.report.requestKey, 'codex:thread-1:call-1:execCommandApproval');
  });

  test('an MCP elicitation shows its message but never its URL', () => {
    const blocker = codexServerRequestBlocker(fixtures.elicitation)!;
    assert.equal(blocker.report.summary, 'docs: Sign in to continue');
    assert.doesNotMatch(JSON.stringify(blocker), /token=secret/);
    assert.deepEqual(blocker.report.responseActions, ['pause', 'cancel']);
  });

  test('silence, narrative, notifications and non-blocking requests never produce a blocker', () => {
    assert.equal(codexServerRequestBlocker(fixtures.nonBlockingInput), null);
    assert.equal(codexServerRequestBlocker({ method: 'item/completed',
      params: { item: { type: 'agentMessage', text: 'Should I use Postgres? Let me know.' } } }), null);
    assert.equal(codexServerRequestBlocker({ method: 'item/tool/requestUserInput', params: fixtures.userInput.params }), null,
      'a notification without a request id is not something ProPR can answer');
    assert.equal(codexServerRequestBlocker({ id: 7, method: 'item/tool/call', params: {} }), null);
    assert.equal(codexServerRequestBlocker({ id: 8, method: 'account/chatgptAuthTokens/refresh', params: {} }), null);
  });

  test('provider support is documented per provider and unknown providers claim nothing', () => {
    assert.equal(goalBlockerSupport('codex').question, 'supported');
    assert.equal(goalBlockerSupport('codex').approval, 'handoff');
    for (const provider of ['claude', 'antigravity', 'opencode', null]) {
      assert.equal(goalBlockerSupport(provider).question, 'unavailable');
      assert.equal(goalBlockerSupport(provider).approval, 'unavailable');
      assert.equal(goalBlockerSupport(provider).paused, 'supported');
    }
  });
});

/** A connection stub holding the queues the App Server reader fills between awaits. */
function providerRequestHarness() {
  const queued = { requests: [] as Array<Record<string, unknown>>, resolved: [] as Array<number | string> };
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const connection = {
    takeServerRequests: () => queued.requests.splice(0),
    takeResolvedServerRequests: () => queued.resolved.splice(0),
    respond: (id: number | string, result: Record<string, unknown>) => { responses.push({ id, result }); },
  } as unknown as AppServerConnection;
  const control = {
    reportBlocker: async (report: { requestKey: string }) => { calls.push(`report:${report.requestKey}`); },
    resolveBlocker: async (key: string, reason: string) => { calls.push(`resolve:${key}:${reason}`); },
    markInputDelivered: async (id: string) => { calls.push(`delivered:${id}`); },
  } as unknown as NonNullable<AgentTaskOptions['goalControl']>;
  return { queued, responses, calls, requests: new CodexProviderRequests(connection, control) };
}

describe('Codex provider requests', () => {
  test('a question answers with the next input and stays open until the provider resolves it', async () => {
    const harness = providerRequestHarness();
    harness.queued.requests.push(fixtures.userInput);
    await harness.requests.sync();
    assert.equal(await harness.requests.answer({ id: 'input-1', message: 'Postgres' }, 'turn-1'), true);
    assert.deepEqual(harness.responses, [{ id: 0, result: { answers: { db: { answers: ['Postgres'] } } } }]);
    assert.equal(await harness.requests.answer({ id: 'input-2', message: 'later' }, 'turn-1'), false,
      'an answered question does not take a second input');
    assert.deepEqual(harness.calls, ['report:codex:thread-1:turn-1:item-7:user-input', 'delivered:input-1']);
  });

  test('a resolution received while the caller awaited releases the question before any input is spent on it', async () => {
    const harness = providerRequestHarness();
    harness.queued.requests.push(fixtures.userInput);
    await harness.requests.sync();
    // `serverRequest/resolved` arrives during the caller's `control.load()`.
    harness.queued.resolved.push(0);
    assert.equal(await harness.requests.answer({ id: 'input-1', message: 'Postgres' }, 'turn-1'), false);
    assert.deepEqual(harness.responses, [], 'no reply is written to a resolved request');
    assert.deepEqual(harness.calls, [
      'report:codex:thread-1:turn-1:item-7:user-input',
      'resolve:codex:thread-1:turn-1:item-7:user-input:provider_resolved',
    ], 'the input is left for ordinary delivery, not marked delivered');
  });

  test('a question raised and resolved between syncs never receives the input', async () => {
    const harness = providerRequestHarness();
    harness.queued.requests.push(fixtures.userInput);
    harness.queued.resolved.push(0);
    assert.equal(await harness.requests.answer({ id: 'input-1', message: 'Postgres' }, 'turn-1'), false);
    assert.deepEqual(harness.responses, []);
    assert.ok(!harness.calls.includes('delivered:input-1'));
  });

  test('a multi-question request never consumes an input', async () => {
    const harness = providerRequestHarness();
    harness.queued.requests.push(fixtures.multiQuestionInput);
    await harness.requests.sync();
    assert.equal(await harness.requests.answer({ id: 'input-1', message: 'Postgres' }, 'turn-1'), false);
    assert.deepEqual(harness.responses, []);
  });
});

const runningGoal: GoalBlockerGoalState = {
  goal_id: 'goal-1', repository: 'acme/web', current_task_id: 'task-1', agent_type: 'codex',
  desired_state: 'running', result_state: null, pause_confirmed_at: null, resume_requested: false,
  run_generation: 2, run_claim: 'claim-2', session_id: 'thread-1',
};

function row(overrides: Partial<GoalBlockerRow> = {}): GoalBlockerRow {
  return {
    blocker_id: 'blocker-1', goal_id: 'goal-1', repository: 'acme/web', task_id: 'task-1',
    run_generation: 2, run_claim: 'claim-2', session_id: 'thread-1', turn_id: 'turn-1', provider: 'codex',
    category: 'question', source: 'codex_app_server:item/tool/requestUserInput', summary: 'Which database?',
    questions: JSON.stringify([{ id: 'db', header: null, question: 'Which database?', options: [], confidential: false }]),
    response_actions: JSON.stringify(['send_input', 'pause', 'cancel']), status: 'open',
    first_observed_at: '2026-10-03 10:00:00', last_observed_at: '2026-10-03 10:00:05',
    ...overrides,
  };
}

describe('shared goal attention projection', () => {
  test('a provider question on the live attempt is one actionable blocker', () => {
    const attention = projectGoalAttention(runningGoal, [row(), row()]);
    assert.equal(attention.waitingForOperator, true);
    assert.equal(attention.reason, 'provider_question');
    assert.equal(attention.blockers.length, 1, 'a duplicated row never duplicates the blocker');
    const [blocker] = attention.blockers;
    assert.equal(blocker.summary, 'Which database?');
    assert.equal(blocker.goalId, 'goal-1');
    assert.equal(blocker.firstObservedAt, '2026-10-03T10:00:00.000Z');
    assert.equal(blocker.actionable, true);
    assert.deepEqual(blocker.attempt, { generation: 2, claim: 'claim-2', sessionId: 'thread-1', turnId: 'turn-1' });
    assert.deepEqual(blocker.detection, { kind: 'provider_event', source: 'codex_app_server:item/tool/requestUserInput' });
  });

  test('stale attempts, replaced sessions, closed rows and stopped goals are never projected', () => {
    assert.equal(projectGoalAttention(runningGoal, [row({ run_generation: 1 })]).waitingForOperator, false);
    assert.equal(projectGoalAttention(runningGoal, [row({ run_claim: 'claim-1' })]).waitingForOperator, false);
    assert.equal(projectGoalAttention(runningGoal, [row({ session_id: 'thread-old' })]).waitingForOperator, false);
    assert.equal(projectGoalAttention(runningGoal, [row({ status: 'resolved' })]).waitingForOperator, false);
    assert.equal(projectGoalAttention(runningGoal, [row({ category: 'rate_limited' })]).waitingForOperator, false);
    assert.equal(projectGoalAttention({ ...runningGoal, result_state: 'completed' }, [row()]).waitingForOperator, false);
    assert.equal(projectGoalAttention({ ...runningGoal, desired_state: 'cancelled' }, [row()]).waitingForOperator, false);
  });

  test('a confirmed pause is preserved and a queued resume no longer waits for a pause response', () => {
    const paused = { ...runningGoal, desired_state: 'paused', pause_confirmed_at: '2026-10-03 09:00:00' };
    const attention = projectGoalAttention(paused, [row()]);
    assert.equal(attention.reason, 'paused_awaiting_resume_or_input');
    assert.deepEqual(attention.blockers.map(blocker => blocker.category), ['paused'],
      'a paused goal interrupted the provider turn, so its question is no longer waiting');
    assert.deepEqual(attention.blockers[0].responseActions, ['resume', 'send_input', 'cancel']);
    assert.equal(attention.blockers[0].id, 'goal-pause:goal-1:2026-10-03T09:00:00.000Z');
    assert.equal(projectGoalAttention({ ...paused, resume_requested: true }).waitingForOperator, false);
    assert.equal(projectGoalAttention({ ...paused, pause_confirmed_at: null }).waitingForOperator, false,
      'a pause that is still pending is not yet waiting on anyone');
  });

  test('silence produces no blocker and stored provider text is re-bounded', () => {
    assert.deepEqual(projectGoalAttention(runningGoal, []), { waitingForOperator: false, reason: null, blockers: [] });
    const long = projectGoalAttention(runningGoal, [row({ summary: 'x'.repeat(5000), response_actions: '["approve","pause"]' })]);
    assert.ok(long.blockers[0].summary.length <= 1000);
    assert.deepEqual(long.blockers[0].responseActions, ['pause'], 'unsupported actions are never offered');
  });
});

describe('persisted blocker lifecycle', () => {
  let db: Knex;
  const attempt = { goalId: '11111111-1111-4111-8111-111111111111', taskId: 'task-1', generation: 2, claimId: 'claim-2' };
  const owner = { owner_id: 'owner-1', repository: 'acme/web', session_id: 'thread-1', agent_type: 'codex' };

  test('records once, refreshes on repeats, resolves on evidence and never resurrects', async () => {
    db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
      await db.migrate.latest({ directory: fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url)) });
      await db('goals').insert({
        goal_id: attempt.goalId, owner_id: 'owner-1', owner_login: 'owner', repository: 'acme/web', objective: 'o', launch_strategy: 'direct',
        initial_prompt: 'p', agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex', requested_model: 'm',
        desired_state: 'running', current_task_id: 'task-1', run_generation: 2, run_claim: 'claim-2',
      });
      const report = codexServerRequestBlocker(fixtures.userInput)!.report;
      assert.equal(await recordGoalBlocker(db, attempt, owner, report), true);
      assert.equal(await recordGoalBlocker(db, attempt, owner, report), true, 'a repeated event refreshes the same row');
      assert.equal((await db('goal_blockers')).length, 1);
      // A delayed event delivered under another attempt's claim does not touch this attempt's row.
      assert.equal(await recordGoalBlocker(db, { ...attempt, claimId: 'claim-1' }, owner, report), false);

      // Answering is not evidence; only the provider (or the end of its turn) resolves it.
      assert.equal(await resolveGoalBlocker(db, { goalId: attempt.goalId, claimId: 'claim-1' }, report.requestKey, 'provider_resolved'), false);
      assert.equal((await db('goal_blockers').first()).status, 'open');
      assert.equal(await resolveGoalBlocker(db, attempt, report.requestKey, 'provider_resolved'), true);
      assert.equal(await recordGoalBlocker(db, attempt, owner, report), false, 'a replayed request stays closed');
      const resolved = await db('goal_blockers').first();
      assert.equal(resolved.status, 'resolved');
      assert.equal(resolved.resolution, 'provider_resolved');

      // Recovery: a new attempt supersedes what the old session raised; its own blockers stay.
      const approval = codexServerRequestBlocker(fixtures.commandApproval)!.report;
      await recordGoalBlocker(db, attempt, owner, approval);
      const next = { ...attempt, generation: 3, claimId: 'claim-3' };
      await recordGoalBlocker(db, next, { ...owner, session_id: 'thread-1' }, codexServerRequestBlocker(fixtures.fileApproval)!.report);
      assert.equal(await closeGoalBlockers(db, attempt.goalId, { exceptClaim: 'claim-3' }, 'superseded_by_attempt'), 1);
      const statuses = Object.fromEntries((await db('goal_blockers').select('run_claim', 'category', 'status'))
        .filter(item => item.category === 'approval').map(item => [item.run_claim, item.status]));
      assert.deepEqual(statuses, { 'claim-2': 'superseded', 'claim-3': 'open' });
      assert.equal(await closeGoalBlockers(db, attempt.goalId, { claim: 'claim-3' }, 'attempt_ended'), 1);
      assert.equal(await db('goal_blockers').where({ status: 'open' }).count({ count: '*' }).first().then(r => Number(r?.count)), 0);
    } finally {
      await db.destroy();
    }
  });
});
