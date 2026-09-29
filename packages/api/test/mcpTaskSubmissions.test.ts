/* eslint-disable max-lines -- submission tracking regressions share one stateful MCP fixture */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import knex from 'knex';
import { z } from 'zod';
import { associateSubmissionTask, closeConnection } from '@propr/core';
import { up as mcpMigration } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { up as submissionMigration } from '../../core/src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../../core/src/db/migrations/20260922010000_preserve_task_submission_identity.js';
import { createToolCatalog, executeTool, type ToolDeps } from '../mcp/tools.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { McpError } from '../mcp/config.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { McpOperations, type Operation } from '../mcp/operations.js';
import { trackExecution } from '../mcp/operationTracking.js';
import { trackTaskSubmission } from '../mcp/toolsTaskSubmissions.js';

after(closeConnection);

interface SubmissionData {
  state: string;
  taskId: string | null;
  issueUrl: string | null;
  submissionId: string;
  error: string | null;
  continuation: { taskId?: string };
  progress: {
    stage: string;
    issue: { number: number; url: string } | null;
    task: { id: string; state: string | null; failureReason: string | null } | null;
    pullRequest: { number: number; url: string; state: string | null } | null;
    next: string;
  };
}
interface Receipt {
  operationId: string;
  state: string;
  result: SubmissionData;
  retryAfterSeconds?: number;
  lifecycle: {
    state: string; acceptedAt: string; startedAt: string | null; finishedAt: string | null;
    failure: unknown; artifacts: Record<string, unknown>; progress: unknown;
  };
}

async function fixture() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('task_drafts', table => { table.string('draft_id').primary(); });
  await mcpMigration(db);
  await submissionMigration(db);
  await identityMigration(db);
  await db.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('repository'); table.string('task_type');
    table.integer('pr_number'); table.string('initial_job_data'); table.text('final_result');
    table.timestamp('created_at').defaultTo(db.fn.now());
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id'); table.string('task_id'); table.string('state');
    table.string('reason'); table.string('metadata'); table.timestamp('timestamp').defaultTo(db.fn.now());
  });
  await db.schema.createTable('notification_pull_request_state', table => {
    table.string('repository'); table.integer('pr_number'); table.string('merged_at');
    table.primary(['repository', 'pr_number']);
  });
  const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  const controls = { queueFailure: false, ambiguousCreation: false, rejectedCreation: false, writeAccess: true };
  let enqueues = 0;
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  policy.repository = async (principal, repository, write) => {
    if (!principal.grant.repositories.includes(repository) || (write && !controls.writeAccess)) throw new McpError('REPOSITORY_FORBIDDEN', 'No repository access', 403);
  };
  const principal = { user: { id: 'alice', username: 'alice' }, authorization: { permissions: [] },
    grant: { id: 'grant-1', repositories: ['owner/repo', 'owner/other'] }, scopes: ['read', 'execute'] } as unknown as McpPrincipal;
  const deps: ToolDeps = { db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never,
    taskSubmissionServices: {
      authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'release' }),
      routing: async body => {
        if (body.model === 'unsupported') throw Object.assign(new Error('Unsupported model'), { status: 400 });
        return { agentAlias: body.agentAlias || 'default-agent', model: body.model || 'default-model', routingLabel: 'llm-agent-model' };
      },
      getOctokit: async () => ({ request: async (route: string, body: Record<string, unknown>) => {
        calls.push({ route, body });
        const issue = { number: 42, html_url: 'https://github.com/owner/repo/issues/42' };
        if (route === 'POST /repos/{owner}/{repo}/issues') {
          if (controls.rejectedCreation) throw Object.assign(new Error('Invalid issue request'), { status: 422 });
          if (controls.ambiguousCreation) throw new Error('Connection lost after issue creation');
          return { data: issue };
        }
        if (route === 'GET /repos/{owner}/{repo}/issues') return { data: [{ ...issue, body: calls.find(call => call.route.startsWith('POST') && call.route.endsWith('/issues'))!.body.body }] };
        if (route.endsWith('/timeline')) return { data: [] };
        return { data: {} };
      } }) as never,
      processingLabels: async () => ['AI'],
      enqueue: async input => { assert.equal(input.userId, 'alice'); enqueues++; if (controls.queueFailure) throw new Error('Queue unavailable'); },
    },
  };
  const catalog = createToolCatalog(deps);
  const call = (name: string, args: Record<string, unknown>, user = principal) => executeTool(catalog.find(tool => tool.name === name)!, args, user, deps);
  return { db, calls, controls, principal, deps, catalog, call, enqueues: () => enqueues };
}

test('MCP launches ordinary issue work once and follows delayed task association through completion', async () => {
  const f = await fixture();
  try {
    for (const name of ['create_task', 'get_task_submission', 'retry_task_submission', 'list_task_submissions']) {
      assert.ok(z.toJSONSchema(f.catalog.find(tool => tool.name === name)!.schema));
    }
    const args = { repository: 'Owner/Repo', instruction: '  Fix invoice dates.\nKeep the formatting.  ', idempotencyKey: 'create-invoice-task' };
    const first = await f.call('create_task', args);
    const receipt = first.data as Receipt;
    assert.equal(receipt.state, 'queued');
    assert.equal(receipt.lifecycle.state, 'accepted');
    assert.ok(receipt.lifecycle.acceptedAt);
    assert.equal(receipt.result.taskId, null);
    assert.equal(receipt.result.issueUrl, 'https://github.com/owner/repo/issues/42');
    assert.equal(receipt.result.progress.stage, 'queued');
    assert.deepEqual(receipt.result.progress.issue, { number: 42, url: 'https://github.com/owner/repo/issues/42' });
    assert.equal(receipt.lifecycle.artifacts.submissionId, receipt.result.submissionId);
    assert.deepEqual((await f.call('create_task', args)).data, first.data);
    assert.equal((await f.db('task_submissions')).length, 1);
    assert.equal(f.enqueues(), 1);
    const creates = f.calls.filter(call => call.route === 'POST /repos/{owner}/{repo}/issues');
    assert.equal(creates.length, 1);
    assert.ok(String(creates[0].body.body).startsWith(args.instruction + '\n\n---'));
    assert.deepEqual(creates[0].body.labels, []);
    assert.deepEqual(f.calls.filter(call => call.route.endsWith('/labels')).map(call => call.body.labels), [['llm-agent-model'], ['base-release'], ['AI']]);
    assert.equal((await f.db('task_drafts')).length, 0);
    assert.equal(await f.db.schema.hasTable('goals'), false);
    const stored = await f.db('task_submissions').first();
    assert.equal(stored.submission_key, `mcp-${receipt.operationId}`);
    assert.equal(JSON.parse(stored.payload).agentAlias, 'default-agent');
    await assert.rejects(f.call('create_task', { ...args, instruction: 'Different work' }), /different arguments/);
    const poll = async () => (await f.call('get_operation', { operationId: receipt.operationId })).data as Receipt;
    assert.equal((await poll()).state, 'queued');
    await f.db('tasks').insert({ task_id: 'ordinary-task', repository: 'owner/repo', task_type: 'issue' });
    await f.db('task_submissions').update({ task_id: 'ordinary-task' });
    await f.db('task_history').insert({ task_id: 'ordinary-task', state: 'processing' });
    const running = await poll();
    assert.equal(running.state, 'running');
    assert.equal(running.lifecycle.state, 'running');
    assert.equal(running.result.progress.stage, 'running');
    assert.equal(running.result.progress.task?.id, 'ordinary-task');
    assert.ok(running.lifecycle.startedAt);
    assert.equal(running.lifecycle.artifacts.taskId, 'ordinary-task');
    const status = await f.call('get_task_submission', { repository: 'owner/repo', submissionId: stored.id });
    assert.equal((status.data as SubmissionData).taskId, 'ordinary-task');
    assert.equal((status.data as SubmissionData).progress.stage, 'running');
    assert.equal(status.links.ui, 'https://instance.example/tasks/ordinary-task');
    assert.equal(status.links.resource, `propr://instances/test/submissions/${stored.id}`);
    await f.db('tasks').where({ task_id: 'ordinary-task' }).update({ pr_number: 45 });
    await f.db('notification_pull_request_state').insert({ repository: 'owner/repo', pr_number: 45,
      merged_at: '2026-09-29T14:00:00.000Z' });
    await f.db('task_history').insert({ task_id: 'ordinary-task', state: 'completed' });
    const [completed, concurrent] = await Promise.all([poll(), poll()]);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.lifecycle.state, 'completed');
    assert.equal(concurrent.lifecycle.state, 'completed');
    assert.ok(completed.lifecycle.finishedAt);
    assert.equal(completed.lifecycle.artifacts.taskId, 'ordinary-task');
    assert.deepEqual(completed.lifecycle.artifacts.pullRequest, {
      repository: 'owner/repo', number: 45, url: 'https://github.com/owner/repo/pull/45',
    });
    assert.equal(completed.result.progress.stage, 'completed');
    assert.deepEqual(completed.result.progress.pullRequest, {
      number: 45, url: 'https://github.com/owner/repo/pull/45', state: 'merged',
    });
    assert.equal(completed.result.continuation.taskId, 'ordinary-task');
    assert.equal(completed.retryAfterSeconds, undefined);
    await f.db('tasks').where({ task_id: 'ordinary-task' }).update({ pr_number: null,
      final_result: JSON.stringify({ postProcessing: { pr: { number: 46 } } }) });
    const fallback = (await f.call('get_task_submission', {
      repository: 'owner/repo', submissionId: stored.id,
    })).data as SubmissionData;
    assert.deepEqual(fallback.progress.pullRequest, {
      number: 46, url: 'https://github.com/owner/repo/pull/46', state: null,
    });
    await f.db('task_history').where({ task_id: 'ordinary-task' }).delete();
    const durable = await poll();
    assert.equal(durable.lifecycle.state, 'completed');
    assert.equal(durable.lifecycle.artifacts.taskId, 'ordinary-task');
  } finally { await f.db.destroy(); }
});

test('MCP retries failed dispatch and reconciles ambiguous creation without duplicating GitHub issues', async () => {
  for (const failure of ['queueFailure', 'ambiguousCreation'] as const) {
    const f = await fixture();
    try {
      f.controls[failure] = true;
      const args = { repository: 'owner/repo', instruction: 'Fix the dates', agentAlias: 'chosen-agent', model: 'chosen-model', idempotencyKey: 'create-task-key' };
      const receipt = (await f.call('create_task', args)).data as Receipt;
      assert.equal(receipt.state, failure === 'queueFailure' ? 'failed' : 'unknown');
      assert.ok(receipt.result.error);
      const stored = await f.db('task_submissions').first();
      assert.equal(JSON.parse(stored.payload).model, 'chosen-model');
      assert.equal(JSON.parse(stored.payload).agentAlias, 'chosen-agent');
      f.controls[failure] = false;
      const retryArgs = { repository: 'owner/repo', submissionId: stored.id, idempotencyKey: 'retry-task-key' };
      const retry = (await f.call('retry_task_submission', retryArgs)).data as Receipt;
      assert.equal(retry.state, 'queued');
      assert.equal(retry.result.submissionId, stored.id);
      assert.deepEqual((await f.call('retry_task_submission', retryArgs)).data, retry);
      assert.equal(f.enqueues(), failure === 'queueFailure' ? 2 : 1);
      assert.equal(f.calls.filter(call => call.route === 'POST /repos/{owner}/{repo}/issues').length, 1);
      const recovered = (await f.call('get_operation', { operationId: receipt.operationId })).data as Receipt;
      assert.equal(recovered.state, 'queued');
      assert.equal(recovered.result.error, null);
    } finally { await f.db.destroy(); }
  }
});

test('preparation failures report failed progress and only appear in failed submission lists', async () => {
  const f = await fixture();
  try {
    f.controls.rejectedCreation = true;
    await f.call('create_task', {
      repository: 'owner/repo', instruction: 'Invalid issue', idempotencyKey: 'rejected-issue',
    });
    const stored = await f.db('task_submissions').first();
    assert.equal(stored.state, 'prepared');
    assert.ok(stored.error);
    assert.equal(stored.task_id, null);

    const failedRead = (await f.call('get_task_submission', {
      repository: 'owner/repo', submissionId: stored.id,
    })).data as SubmissionData;
    assert.equal(failedRead.state, 'failed');
    assert.equal(failedRead.progress.stage, 'failed');
    assert.equal(failedRead.progress.task, null);
    assert.equal(failedRead.progress.next, 'The task failed; inspect the failure reason before retrying.');

    const active = (await f.call('list_task_submissions', { stage: 'active' })).data as {
      submissions: SubmissionData[];
    };
    assert.deepEqual(active.submissions, []);
    const failed = (await f.call('list_task_submissions', { stage: 'failed' })).data as {
      submissions: SubmissionData[];
    };
    assert.deepEqual(failed.submissions.map(submission => submission.submissionId), [stored.id]);
    assert.equal(failed.submissions[0].progress.stage, 'failed');
  } finally { await f.db.destroy(); }
});

test('MCP validates direct task inputs and enforces execute scope, repository write access and submission ownership', async () => {
  const f = await fixture();
  const args = { repository: 'owner/repo', instruction: 'Fix it', idempotencyKey: 'valid-task-key' };
  try {
    for (const instruction of ['', ' \n ', 'x'.repeat(50001)]) await assert.rejects(f.call('create_task', { ...args, instruction }));
    await assert.rejects(f.call('create_task', { ...args, goalId: 'not-a-goal' }));
    await assert.rejects(f.call('create_task', args, { ...f.principal, scopes: ['read'] }), /requires execute/);
    f.controls.writeAccess = false;
    await assert.rejects(f.call('create_task', args), /No repository access/);
    f.controls.writeAccess = true;
    await assert.rejects(f.call('create_task', { ...args, repository: 'outside/grant' }), /No repository access/);
    const invalid = (await f.call('create_task', { ...args, model: 'unsupported' })).data as Receipt;
    assert.equal(invalid.state, 'failed');
    assert.equal(f.calls.length, 0);
    await f.call('create_task', { ...args, idempotencyKey: 'another-task-key' });
    const stored = await f.db('task_submissions').first();
    for (const tool of ['get_task_submission', 'retry_task_submission']) {
      const input = { repository: 'owner/repo', submissionId: stored.id, ...(tool.startsWith('retry') ? { idempotencyKey: 'retry-access-key' } : {}) };
      await assert.rejects(f.call(tool, input, { ...f.principal, user: { ...f.principal.user, id: 'bob' } }), /not found/);
      await assert.rejects(f.call(tool, { ...input, repository: 'owner/other' }), /not found/);
    }
    assert.equal(f.enqueues(), 1);
  } finally { await f.db.destroy(); }
});

test('submission reads redact task failures and active lists are owner-scoped without GitHub reads', async () => {
  const f = await fixture();
  try {
    await f.call('create_task', { repository: 'owner/repo', instruction: 'Keep this queued', idempotencyKey: 'active-submission' });
    await f.call('create_task', { repository: 'owner/repo', instruction: 'Let this fail', idempotencyKey: 'failed-submission' });
    const submissions = await f.db('task_submissions').orderBy('created_at').orderBy('id');
    const failed = submissions.find(row => JSON.parse(row.payload).instruction === 'Let this fail')!;
    await f.db('tasks').insert({ task_id: 'failed-task', repository: 'owner/repo', task_type: 'issue' });
    await associateSubmissionTask(f.db, failed.id, 'failed-task');
    await f.db('task_history').insert({ task_id: 'failed-task', state: 'failed',
      reason: 'Provider rejected github_pat_secret_value_1234567890 and Bearer private-token' });

    const githubCalls = f.calls.length;
    const failedRead = (await f.call('get_task_submission', {
      repository: 'owner/repo', submissionId: failed.id,
    })).data as SubmissionData;
    assert.equal(failedRead.progress.stage, 'failed');
    assert.equal(failedRead.progress.task?.id, 'failed-task');
    assert.equal(failedRead.progress.task?.failureReason,
      'Provider rejected [REDACTED] and Bearer [REDACTED]');

    const active = (await f.call('list_task_submissions', { stage: 'active' })).data as {
      submissions: SubmissionData[]; nextOffset: number | null;
    };
    assert.equal(active.submissions.length, 1);
    assert.equal(active.submissions[0].progress.stage, 'queued');
    assert.equal(active.nextOffset, null);
    const bob = { ...f.principal, user: { ...f.principal.user, id: 'bob' } } as McpPrincipal;
    const hidden = (await f.call('list_task_submissions', { repository: 'owner/repo', stage: 'active' }, bob)).data as {
      submissions: SubmissionData[];
    };
    assert.deepEqual(hidden.submissions, []);
    assert.equal(f.calls.length, githubCalls);
  } finally { await f.db.destroy(); }
});


test('an unpolled successful launch receipt stays with its execution after a later retry starts or fails', async () => {
  for (const retryState of ['processing', 'failed']) {
    const f = await fixture();
    try {
      const receipt = (await f.call('create_task', {
        repository: 'owner/repo', instruction: 'Fix dates', idempotencyKey: `unpolled-launch-${retryState}`,
      })).data as Receipt;
      const submission = await f.db('task_submissions').first();
      await f.db('tasks').insert([
        { task_id: 'first-task', repository: 'owner/repo', task_type: 'issue' },
        { task_id: 'later-task', repository: 'owner/repo', task_type: 'issue' },
      ]);
      await associateSubmissionTask(f.db, submission.id, 'first-task');
      await f.db('task_history').insert({ task_id: 'first-task', state: 'completed' });
      await associateSubmissionTask(f.db, submission.id, 'later-task');
      await f.db('task_history').insert({ task_id: 'later-task', state: retryState });

      const result = (await f.call('get_operation', { operationId: receipt.operationId })).data as Receipt;
      assert.equal(result.state, 'completed');
      assert.equal(result.lifecycle.state, 'completed');
      assert.equal(result.result.taskId, 'first-task');
      assert.equal(result.result.continuation.taskId, 'first-task');
      assert.equal(result.result.progress.task.id, 'first-task');
      assert.equal(result.result.progress.stage, 'completed');
      assert.equal(result.lifecycle.artifacts.taskId, 'first-task');
      const direct = (await f.call('get_task_submission', {
        repository: 'owner/repo', submissionId: submission.id,
      })).data as SubmissionData;
      assert.equal(direct.progress.task?.id, 'later-task');
      assert.equal(direct.progress.stage, retryState === 'failed' ? 'failed' : 'running');
      assert.equal((await f.db('task_submissions').first()).latest_task_id, 'later-task');
    } finally { await f.db.destroy(); }
  }
});

test('terminal task events between submission and execution tracking reconcile the resolving and durable receipts', async () => {
  for (const terminal of ['completed', 'failed'] as const) {
    const f = await fixture();
    try {
      const created = (await f.call('create_task', {
        repository: 'owner/repo', instruction: `Let the task ${terminal}`, idempotencyKey: `interleaved-${terminal}`,
      })).data as Receipt;
      const submission = await f.db('task_submissions').first();
      const taskId = `interleaved-${terminal}-task`;
      await f.db('tasks').insert({ task_id: taskId, repository: 'owner/repo', task_type: 'issue' });
      await associateSubmissionTask(f.db, submission.id, taskId);
      await f.db('task_history').insert({ task_id: taskId, state: 'processing' });

      const operations = new McpOperations(f.db);
      const row = (await f.db<Operation>('mcp_operations').where({ id: created.operationId }).first())!;
      const resolving = operations.project(row) as unknown as Receipt;
      await trackTaskSubmission(f.deps, row, f.principal, resolving as unknown as Record<string, unknown>);
      assert.equal(resolving.result.progress.stage, 'running');
      const staleProgress = resolving.result.progress;

      await f.db('task_history').insert({ task_id: taskId, state: terminal,
        reason: terminal === 'failed' ? 'Provider rejected github_pat_secret_value_1234567890' : null });
      await trackExecution(f.deps, row, f.principal, resolving as unknown as Record<string, unknown>);

      assert.equal(resolving.state, terminal);
      assert.equal(resolving.result.progress.stage, terminal);
      assert.equal(resolving.result.progress.task?.id, taskId);
      assert.equal(resolving.result.progress.task?.state, terminal);
      assert.equal(resolving.result.progress.task?.failureReason,
        terminal === 'failed' ? 'Provider rejected [REDACTED]' : null);
      assert.equal(resolving.result.progress.next, terminal === 'failed'
        ? 'The task failed; inspect the failure reason before retrying.' : 'The task completed.');

      // A later poll also repairs receipts persisted by the former interleaving bug.
      const storedResult = JSON.parse((await f.db('mcp_operations').where({ id: created.operationId }).first()).result);
      await f.db('mcp_operations').where({ id: created.operationId })
        .update({ result: JSON.stringify({ ...storedResult, progress: staleProgress }) });
      const durable = (await f.call('get_operation', { operationId: created.operationId })).data as Receipt;
      assert.equal(durable.state, terminal);
      assert.equal(durable.result.progress.stage, terminal);
      assert.equal(durable.result.progress.task?.id, taskId);
      assert.equal(durable.result.progress.task?.state, terminal);
      assert.equal(durable.result.progress.task?.failureReason,
        terminal === 'failed' ? 'Provider rejected [REDACTED]' : null);
      assert.equal(durable.retryAfterSeconds, undefined);
    } finally { await f.db.destroy(); }
  }
});

test('a resolved launch receipt stays with its completed execution while submission reads follow a running retry', async () => {
  const f = await fixture();
  try {
    const receipt = (await f.call('create_task', {
      repository: 'owner/repo', instruction: 'Fix dates', idempotencyKey: 'resolved-launch',
    })).data as Receipt;
    const submission = await f.db('task_submissions').first();
    const poll = async () => (await f.call('get_operation', { operationId: receipt.operationId })).data as Receipt;

    await f.db('tasks').insert({ task_id: 'completed-task', repository: 'owner/repo', task_type: 'issue' });
    await associateSubmissionTask(f.db, submission.id, 'completed-task');
    await f.db('task_history').insert({ task_id: 'completed-task', state: 'processing' });
    assert.equal((await poll()).state, 'running');
    await f.db('task_history').insert({ task_id: 'completed-task', state: 'completed' });

    // The first execution finishes between polls while an issue retry
    // independently advances the submission's latest-task pointer.
    await f.db('tasks').where({ task_id: 'completed-task' }).update({ pr_number: 45 });
    await f.db('notification_pull_request_state').insert({
      repository: 'owner/repo', pr_number: 45, merged_at: '2026-09-29T14:00:00.000Z',
    });
    await f.db('tasks').insert({ task_id: 'retry-task', repository: 'owner/repo', task_type: 'issue', pr_number: 99 });
    await associateSubmissionTask(f.db, submission.id, 'retry-task');
    await f.db('task_history').insert({ task_id: 'retry-task', state: 'processing' });

    const submissionRead = (await f.call('get_task_submission', {
      repository: 'owner/repo', submissionId: submission.id,
    })).data as SubmissionData;
    assert.equal(submissionRead.progress.stage, 'running');
    assert.equal(submissionRead.progress.task?.id, 'retry-task');
    assert.equal(submissionRead.progress.pullRequest?.number, 99);

    for (const resolved of [await poll(), await poll()]) {
      assert.equal(resolved.state, 'completed');
      assert.equal(resolved.lifecycle.state, 'completed');
      assert.equal(resolved.result.taskId, 'completed-task');
      assert.equal(resolved.result.continuation.taskId, 'completed-task');
      assert.equal(resolved.result.progress.stage, 'completed');
      assert.equal(resolved.result.progress.task?.id, 'completed-task');
      assert.deepEqual(resolved.result.progress.pullRequest, {
        number: 45, url: 'https://github.com/owner/repo/pull/45', state: 'merged',
      });
      assert.equal(resolved.lifecycle.artifacts.taskId, 'completed-task');
      assert.deepEqual(resolved.lifecycle.artifacts.pullRequest, {
        repository: 'owner/repo', number: 45, url: 'https://github.com/owner/repo/pull/45',
      });
      assert.equal(resolved.retryAfterSeconds, undefined);
    }
  } finally { await f.db.destroy(); }
});

const automationKeys = ['autoMerge', 'runUltrafix', 'ultrafixGoal', 'ultrafixMaxCycles'] as const;
const storedAutomation = (payload: Record<string, unknown>) => Object.fromEntries(automationKeys.filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));

test('create_task requests ultrafix and auto-merge through the shared issue labels used by planned work', async () => {
  const routing = [['llm-agent-model'], ['base-release']];
  const scenarios = [
    { key: 'plain-task', args: {}, labels: [...routing, ['AI']], automation: {} },
    { key: 'ultrafix-defaults', args: { runUltrafix: true }, labels: [...routing, ['ultrafix'], ['AI']],
      automation: { runUltrafix: true, ultrafixGoal: 9, ultrafixMaxCycles: 3 } },
    { key: 'ultrafix-explicit', args: { runUltrafix: true, ultrafixGoal: 6, ultrafixMaxCycles: 2, autoMerge: true },
      labels: [...routing, ['auto-merge'], ['ultrafix'], ['AI']],
      automation: { autoMerge: true, runUltrafix: true, ultrafixGoal: 6, ultrafixMaxCycles: 2 } },
    // Bounds are meaningful only for an ultrafix run and are otherwise dropped.
    { key: 'bounds-without-opt-in', args: { ultrafixGoal: 6, ultrafixMaxCycles: 2 }, labels: [...routing, ['AI']], automation: {} },
  ];
  for (const scenario of scenarios) {
    const f = await fixture();
    const principal = { ...f.principal, scopes: ['read', 'execute', 'review', 'merge'] } as unknown as McpPrincipal;
    try {
      const receipt = (await f.call('create_task', { repository: 'owner/repo', instruction: 'Fix invoice dates',
        idempotencyKey: scenario.key, ...scenario.args }, principal)).data as Receipt;
      assert.equal(receipt.state, 'queued');
      assert.deepEqual(f.calls.filter(call => call.route.endsWith('/labels')).map(call => call.body.labels), scenario.labels);
      assert.deepEqual(storedAutomation(JSON.parse((await f.db('task_submissions').first()).payload)), scenario.automation);
    } finally { await f.db.destroy(); }
  }
});

test('create_task rejects out-of-range ultrafix bounds and requires review and merge scope for automation', async () => {
  const f = await fixture();
  const principal = { ...f.principal, scopes: ['read', 'execute', 'review', 'merge'] } as unknown as McpPrincipal;
  const args = { repository: 'owner/repo', instruction: 'Fix it', runUltrafix: true, idempotencyKey: 'automation-bounds' };
  try {
    for (const invalid of [{ ultrafixGoal: 0 }, { ultrafixGoal: 11 }, { ultrafixGoal: 2.5 }, { ultrafixMaxCycles: 0 },
      { ultrafixMaxCycles: 11 }, { runUltrafix: 'yes' }, { autoMerge: 1 }, { ultrafixCycles: 3 }]) {
      await assert.rejects(f.call('create_task', { ...args, ...invalid }, principal));
    }
    // A scope denial becomes a durable failed receipt, exactly as implement_plan reports it.
    for (const [key, request, expected] of [['denied-review', args, /requires review/],
      ['denied-merge', { ...args, runUltrafix: false, autoMerge: true }, /requires merge/]] as const) {
      const denied = (await f.call('create_task', { ...request, idempotencyKey: key })).data as Receipt;
      assert.equal(denied.state, 'failed');
      assert.match(JSON.stringify(denied.result), expected);
    }
    assert.deepEqual([f.calls.length, (await f.db('task_submissions')).length, f.enqueues()], [0, 0, 0]);
  } finally { await f.db.destroy(); }
});
