import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildPlannerAbortSignalKey } from '@propr/core';
import type { McpPrincipal } from '../../mcp/policy.js';
import type { ToolDeps } from '../../mcp/tools.js';
import { runBackgroundGeneration } from '../../routes/plannerHelpers/utils.js';
import { runBackgroundRefinement } from '../../routes/plannerHelpers/refineBackground.js';

type Call = (name: string, args: Record<string, unknown>, mutation?: boolean) => Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface CancellationFixture {
  call: Call; client: { callTool: (args: { name: string; arguments: Record<string, unknown> }) => Promise<{ isError?: unknown }> };
  principal: McpPrincipal; deps: ToolDeps; agentId: string; modern: boolean; root: string; taskId: string; issueNumber: number;
  redisValues: Map<string, string>; plannerSignals: Map<string, string>; setStopGoalImmediately: (value: boolean) => void;
}

export async function verifyCancellation({ call, client, principal, deps, agentId, modern, root, taskId, issueNumber, redisValues, plannerSignals, setStopGoalImmediately }: CancellationFixture): Promise<void> {
  const { db } = deps;
  const repository = 'acme/repo';
  // Real goal cancellation requests must wait for the worker's persisted boundary.
  setStopGoalImmediately(false);
  for (const outcome of ['cancelled', 'completed', 'failed']) {
    const started = await call('create_goal', { repository, objective: `Cancellation ${outcome}`, agentId, model: 'fixture-model', launchStrategy: 'direct' }, true);
    const cancelArgs = { operationId: started.operationId, idempotencyKey: `cancel-${modern}-${outcome}` };
    const requested = await call('cancel_operation', cancelArgs);
    assert.equal(requested.state, 'accepted');
    const targetId = started.result.continuation.goalId;
    assert.equal((await db('goals').where({ goal_id: targetId }).first()).desired_state, 'cancelled');
    assert.equal((await call('get_operation', { operationId: requested.operationId })).state, 'accepted');
    await db('goals').where({ goal_id: targetId }).update({ result_state: outcome });
    const stopped = await call('get_operation', { operationId: requested.operationId });
    assert.equal(stopped.state, 'completed');
    assert.equal(stopped.result.cancellation, outcome === 'cancelled' ? 'confirmed' : 'not_applied');
    assert.equal(stopped.result.targetOutcome, outcome);
    assert.equal(stopped.retryAfterSeconds, undefined);
    assert.deepEqual((await call('cancel_operation', cancelArgs)).result, stopped.result);
    const revoked = principal.grant.repositories;
    principal.grant.repositories = [];
    assert.equal((await client.callTool({ name: 'get_operation', arguments: { operationId: requested.operationId } })).isError, true);
    assert.equal((await client.callTool({ name: 'cancel_operation', arguments: cancelArgs })).isError, true);
    principal.grant.repositories = revoked;
    const owner = principal.user.id;
    principal.user.id = 'another-owner';
    assert.equal((await client.callTool({ name: 'get_operation', arguments: { operationId: requested.operationId } })).isError, true);
    principal.user.id = owner;
    const grantId = principal.grant.id;
    principal.grant.id = 'another-grant';
    assert.equal((await client.callTool({ name: 'get_operation', arguments: { operationId: requested.operationId } })).isError, true);
    principal.grant.id = grantId;
    await db('goals').where({ goal_id: targetId }).delete();
    assert.deepEqual((await call('get_operation', { operationId: requested.operationId })).result, stopped.result);
    assert.deepEqual((await call('cancel_operation', cancelArgs)).result, stopped.result);
  }
  setStopGoalImmediately(true);
  // Task stop uses the real Docker route and Redis abort signal path, without a live container.
  for (const outcome of ['cancelled', 'completed', 'failed']) {
    const next = await call('send_task_followup', { repository, taskId, message: `Stop ${outcome}` }, true);
    const id = next.result.continuation.taskId;
    await db('tasks').insert({ task_id: id, job_id: id, repository, task_type: 'issue', issue_number: issueNumber });
    await db('task_history').insert({ task_id: id, state: 'processing' });
    redisValues.set(`worker:state:${id}`, JSON.stringify({ history: [{ state: 'processing' }] }));
    const requested = await call('cancel_operation', { operationId: next.operationId }, true);
    assert.equal(requested.state, 'accepted', JSON.stringify(requested));
    assert.equal((await call('get_operation', { operationId: requested.operationId })).state, 'accepted');
    await db('task_history').insert({ task_id: id, state: outcome });
    const stopped = await call('get_operation', { operationId: requested.operationId });
    assert.equal(stopped.state, 'completed');
    assert.equal(stopped.result.targetOutcome, outcome);
    assert.equal(stopped.result.cancellation, outcome === 'cancelled' ? 'confirmed' : 'not_applied');
  }

  // The planner handler's draft reset is not a stop. Run real background lifecycles,
  // suspending only provider execution until after the cancellation receipt is polled.
  for (const tool of ['generate_plan', 'refine_plan']) {
    const createdPlan = await call('create_plan', { repository, name: 'Cancellation', prompt: 'Exercise planner stop' }, true);
    const id = createdPlan.result.planId;
    const runId = randomUUID();
    const column = tool === 'generate_plan' ? 'generation_trace' : 'refinement_result';
    await db('task_drafts').where({ draft_id: id }).update({ status: tool === 'generate_plan' ? 'generating' : 'refining', [column]: JSON.stringify({ runId, steps: [] }) });
    // This is the persisted 202 boundary produced by the planner start handler.
    const operationId = randomUUID();
    await db('mcp_operations').insert({ id: operationId, owner_id: principal.user.id, grant_id: principal.grant.id,
      idempotency_key: randomUUID(), tool, repository, payload_hash: 'fixture', state: 'accepted',
      result: JSON.stringify({ runId, continuation: { planId: id } }), created_at: Date.now(), updated_at: Date.now() });
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const provider = async () => { enter(); await hold; throw new Error('Provider stopped at cancellation boundary'); };
    const running = tool === 'generate_plan'
      ? runBackgroundGeneration({ db, draftId: id, worktreePath: root, authToken: '', correlationId: runId, runId }, { generate: provider })
      : runBackgroundRefinement({ db, draftId: id, currentPlan: [], instruction: 'Refine', generationModel: 'fixture-model', correlationId: runId, accessToken: '', runId }, {
        checkAborted: async () => plannerSignals.has(buildPlannerAbortSignalKey(id, runId)),
        getRepoContext: async () => ({ worktreePath: root, repository, authToken: '' }), refine: provider,
      });
    await entered;
    const cancelArgs = { operationId, idempotencyKey: `planner-cancel-${modern}-${tool}` };
    let requested;
    try {
      requested = await call('cancel_operation', cancelArgs);
      assert.equal(requested.state, 'accepted', JSON.stringify(requested));
      assert.equal((await call('get_operation', { operationId: requested.operationId })).state, 'accepted');
      // A replacement run must neither satisfy nor erase the old receipt's stop evidence.
      await db('task_drafts').where({ draft_id: id }).update({ status: 'generating', [column]: JSON.stringify({ runId: randomUUID() }) });
    } finally { release(); await running; }
    const stopped = await call('get_operation', { operationId: requested.operationId });
    assert.equal(stopped.state, 'completed');
    assert.equal(stopped.result.cancellation, 'confirmed');
    assert.equal(stopped.result.targetOutcome, 'cancelled');
    assert.deepEqual((await call('cancel_operation', cancelArgs)).result, stopped.result);
    const stale = await call('cancel_operation', { operationId }, true);
    assert.equal(stale.result.error.code, 'NOT_CANCELLABLE');
    for (const outcome of ['completed', 'failed']) {
      const completedRun = randomUUID(), completedOperation = randomUUID();
      await db('mcp_operations').insert({ id: completedOperation, owner_id: principal.user.id, grant_id: principal.grant.id,
        idempotency_key: randomUUID(), tool, repository, payload_hash: 'fixture', state: 'accepted',
        result: JSON.stringify({ runId: completedRun, continuation: { planId: id } }), created_at: Date.now(), updated_at: Date.now() });
      await db('task_drafts').where({ draft_id: id }).update({
        status: tool === 'generate_plan' && outcome === 'failed' ? 'failed' : 'review',
        [column]: JSON.stringify({ runId: completedRun, status: outcome }),
      });
      const requested = await call('cancel_operation', { operationId: completedOperation }, true);
      assert.equal(requested.state, 'accepted', JSON.stringify(requested));
      const resolved = await call('get_operation', { operationId: requested.operationId });
      assert.equal(resolved.state, 'completed');
      assert.equal(resolved.result.cancellation, 'not_applied');
      assert.equal(resolved.result.targetOutcome, outcome);
    }
  }
}
