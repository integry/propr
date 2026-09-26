import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import type { RedisClientType } from 'redis';
import { appendGoalAttachments, GOAL_ATTACHMENT_SECTION_HEADING } from '../services/goalAttachmentService.js';
import { serializeGoal, type GoalProjectionRow } from '../services/goalProjection.js';

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

test('goal projection redacts nested failure, checkpoint, and provider live-summary preview paths', async () => {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const previewPath = '/tmp/goals/goal-2283/.propr/previews/dashboard.png';
  const sourcePath = '/tmp/goals/goal-2283/.propr/preview-src/capture.ts';
  try {
    await database.schema.createTable('task_history', table => {
      table.increments('history_id');
      table.text('task_id');
      table.text('state');
      table.text('timestamp');
    });
    await database.schema.createTable('goal_inputs', table => {
      table.increments('sequence');
      table.text('input_id');
      table.text('goal_id');
      table.text('owner_id');
      table.text('kind');
      table.text('message');
      table.text('display_message');
      table.integer('attachment_count');
      table.text('state');
      table.text('created_at');
      table.text('delivered_at');
    });
    await database.schema.createTable('goal_checkpoints', table => {
      table.text('checkpoint_id');
      table.text('goal_id');
      table.text('owner_id');
      table.text('kind');
      table.text('state');
      table.text('commit_sha');
      table.text('commit_message');
      table.text('include_paths');
      table.text('exclude_paths');
      table.text('summary');
      table.text('error');
      table.text('created_at');
      table.text('completed_at');
    });
    await database('task_history').insert({
      task_id: 'goal-task-2283', state: 'processing', timestamp: '2026-09-11T00:00:00.000Z',
    });
    await database('goal_checkpoints').insert({
      checkpoint_id: 'checkpoint-1', goal_id: 'goal-2283', owner_id: 'owner-1', kind: 'agent', state: 'failed',
      commit_message: `Capture ${previewPath}`, include_paths: JSON.stringify([sourcePath, 'src/safe.ts']),
      exclude_paths: JSON.stringify([previewPath]), summary: `Rendered from ${sourcePath}`,
      error: `Could not publish ${previewPath}`, created_at: '2026-09-11T00:00:01.000Z', completed_at: null,
    });
    const liveOutput = [
      { method: 'turn/plan/updated', params: { plan: [
        { step: `Inspect ${sourcePath}`, status: 'completed' },
        { step: `Publish ${previewPath}`, status: 'inProgress' },
      ] } },
      { method: 'thread/goal/updated', params: { goal: {
        objective: `Verify ${sourcePath}`, status: 'active', tokenBudget: 1000, tokensUsed: 250, timeUsedSeconds: 30,
      } } },
    ].map(record => JSON.stringify(record)).join('\n');
    const redisClient = {
      get: async (key: string) => {
        if (key === 'agent:output:goal-task-2283') return liveOutput;
        if (key === 'worker:state:goal-task-2283') return JSON.stringify({ history: [{
          state: 'codex_execution', timestamp: '2026-09-11T00:00:00.000Z',
        }] });
        return null;
      },
    } as unknown as RedisClientType;
    const row = {
      goal_id: 'goal-2283', owner_id: 'owner-1', owner_login: 'alice', repository: 'acme/repo',
      title: 'Preview goal', objective: `Ship ${previewPath}`, launch_strategy: 'direct',
      initial_prompt: `Use ${sourcePath}`, attachments: null, base_branch: 'main', branch_name: 'goal/preview',
      worktree_path: '/tmp/goals/goal-2283', agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex',
      requested_model: 'gpt-5.6', effective_model: 'gpt-5.6', max_parallel_tasks: 2, ultrafix: 0,
      desired_state: 'running', result_state: 'failed', current_task_id: 'goal-task-2283', session_id: null,
      conversation_id: null, run_generation: 1, run_claim: null, claimed_at: null, active_turn_id: null,
      pause_confirmed_at: null, resume_requested: 0, final_pr_number: null, final_pr_url: null,
      artifact_refs: null, artifact_stats: null, artifacts_checked_at: null,
      failure_reason: `Provider failed at ${previewPath}`, create_idempotency_key: null,
      create_idempotency_operation: null, create_payload_hash: null, control_generation: 2,
      control_ack_generation: 1, task_reconciled_at: null, created_at: '2026-09-11T00:00:00.000Z',
      updated_at: '2026-09-11T00:00:02.000Z', started_at: '2026-09-11T00:00:00.000Z', paused_at: null,
      paused_ms: 0, completed_at: '2026-09-11T00:00:03.000Z', checkpoint_interval_minutes: 15,
      last_checkpoint_at: '2026-09-11T00:00:01.000Z', last_checkpoint_commit_sha: null,
      checkpoint_count: 1, checkpoint_error: `Checkpoint source ${sourcePath}`,
    } satisfies GoalProjectionRow;

    const projected = await serializeGoal(database, redisClient, row);
    const serialized = JSON.stringify(projected);

    assert.equal(serialized.includes(previewPath), false, serialized);
    assert.equal(serialized.includes(sourcePath), false, serialized);
    assert.match(serialized, /local preview omitted/);
    assert.equal(projected.maxParallelTasks, 2);
    assert.equal(projected.ultrafix, false);
    assert.deepEqual(projected.control, { requestGeneration: 2, acknowledgedGeneration: 1, pending: true });
    assert.equal(projected.checkpoint?.count, 1);
    assert.equal(projected.checkpoint?.latest?.include.length, 2);
    assert.equal(projected.liveSummary.todos.length, 2);
    assert.equal(projected.liveSummary.nativeGoal?.tokensUsed, 250);
  } finally {
    await database.destroy();
  }
});

const inputGoalRow = {
  goal_id: 'goal-2467', owner_id: 'owner-1', owner_login: 'alice', repository: 'acme/repo',
  title: 'Steered goal', objective: 'Ship the dashboard', launch_strategy: 'orchestrate',
  initial_prompt: 'Ship the dashboard', attachments: null, base_branch: 'main', branch_name: 'goal/steered',
  worktree_path: '/tmp/goals/goal-2467', agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex',
  requested_model: 'gpt-5.6', effective_model: null, max_parallel_tasks: null, ultrafix: 0,
  desired_state: 'running', result_state: null, current_task_id: 'goal-task-2467', session_id: null,
  conversation_id: null, run_generation: 1, run_claim: null, claimed_at: null, active_turn_id: null,
  pause_confirmed_at: null, resume_requested: 0, final_pr_number: null, final_pr_url: null,
  artifact_refs: null, artifact_stats: null, artifacts_checked_at: null, failure_reason: null,
  create_idempotency_key: null, create_idempotency_operation: null, create_payload_hash: null,
  control_generation: 0, control_ack_generation: 0, task_reconciled_at: null,
  created_at: '2026-09-22T00:00:00.000Z', updated_at: '2026-09-22T00:00:05.000Z',
  started_at: '2026-09-22T00:00:00.000Z', paused_at: null, paused_ms: 0, completed_at: null,
  checkpoint_interval_minutes: null, last_checkpoint_at: null, last_checkpoint_commit_sha: null,
  checkpoint_count: 0, checkpoint_error: null,
} satisfies GoalProjectionRow;

const emptyRedis = { get: async () => null } as unknown as RedisClientType;

async function inputProjectionDatabase() {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id');
    table.text('task_id');
    table.text('state');
    table.text('timestamp');
  });
  await database.schema.createTable('goal_inputs', table => {
    table.increments('sequence');
    table.text('input_id');
    table.text('goal_id');
    table.text('owner_id');
    table.text('kind');
    table.text('message');
    table.text('display_message');
    table.integer('attachment_count');
    table.text('state');
    table.text('created_at');
    table.text('delivered_at');
  });
  return database;
}

function goalInputRow(overrides: Record<string, unknown>) {
  return {
    goal_id: 'goal-2467', owner_id: 'owner-1', kind: 'input', state: 'pending',
    created_at: '2026-09-22T00:00:01.000Z', delivered_at: null, ...overrides,
  };
}

test('goal projection exposes operator inputs and hides ProPR control-plane rows', async () => {
  const database = await inputProjectionDatabase();
  try {
    await database('goal_inputs').insert([
      goalInputRow({
        input_id: 'input-1', message: 'Focus on the API first', state: 'delivered',
        delivered_at: '2026-09-22T00:00:02.000Z',
      }),
      goalInputRow({ input_id: 'context-1', kind: 'context', message: 'Delivery policy for this provider' }),
      goalInputRow({ input_id: 'resume-1', kind: 'resume', message: 'GOAL_CONTINUE_INPUT' }),
      goalInputRow({ input_id: 'control-1', kind: 'control', message: '', state: 'delivered' }),
      goalInputRow({ input_id: 'input-2', message: 'What is left?', state: 'pending' }),
      goalInputRow({ input_id: 'input-3', message: 'Never landed', state: 'undeliverable', delivered_at: '2026-09-22T00:00:04.000Z' }),
    ]);

    const projected = await serializeGoal(database, emptyRedis, inputGoalRow);

    assert.deepEqual(projected.inputs?.map(entry => entry.id), ['input-1', 'input-2', 'input-3']);
    assert.deepEqual(projected.inputs?.[0], {
      id: 'input-1', message: 'Focus on the API first', attachmentCount: 0,
      state: 'delivered', createdAt: '2026-09-22T00:00:01.000Z', deliveredAt: '2026-09-22T00:00:02.000Z',
    });
    assert.equal(projected.inputs?.[1].state, 'pending');
    assert.equal(projected.inputs?.[1].deliveredAt, null);
    assert.equal(projected.inputs?.[2].state, 'undeliverable');
    assert.equal(JSON.stringify(projected.inputs).includes('GOAL_CONTINUE_INPUT'), false);
  } finally {
    await database.destroy();
  }
});

test('goal projection keeps operator text that quotes the attachment heading', async () => {
  const database = await inputProjectionDatabase();
  try {
    const authored = [
      'Reword the upload hint.',
      '',
      `${GOAL_ATTACHMENT_SECTION_HEADING}`,
      'That sentence reads badly — say "attached files" instead.',
    ].join('\n');
    await database('goal_inputs').insert([
      goalInputRow({ input_id: 'input-1', message: authored, display_message: authored, attachment_count: 0 }),
      // Written before `display_message` existed, so the projection still parses the stored prompt.
      goalInputRow({ input_id: 'input-2', message: authored }),
    ]);

    const projected = await serializeGoal(database, emptyRedis, inputGoalRow);

    assert.equal(projected.inputs?.[0].message, authored);
    assert.equal(projected.inputs?.[0].attachmentCount, 0);
    assert.equal(projected.inputs?.[1].message, authored);
    assert.equal(projected.inputs?.[1].attachmentCount, 0);
  } finally {
    await database.destroy();
  }
});

test('goal projection reports attachment counts without the delivered storage paths', async () => {
  const database = await inputProjectionDatabase();
  try {
    const stored = appendGoalAttachments('Use these mockups', [
      {
        id: 'attachment-1', originalName: 'one.png', storedPath: '/tmp/git-processor/goal-attachments/goal-2467/one.webp',
        mimeType: 'image/webp', size: 10, tokenEstimate: 5, type: 'image' as const,
      },
    ]);
    await database('goal_inputs').insert(goalInputRow({
      input_id: 'input-1', message: stored, display_message: 'Use these mockups', attachment_count: 1,
    }));

    const projected = await serializeGoal(database, emptyRedis, inputGoalRow);

    assert.equal(JSON.stringify(projected).includes('/tmp/git-processor/goal-attachments'), false);
    assert.equal(projected.inputs?.[0].message, 'Use these mockups');
    assert.equal(projected.inputs?.[0].attachmentCount, 1);
  } finally {
    await database.destroy();
  }
});

test('goal projection strips appended attachment paths from rows stored before display bodies', async () => {
  const database = await inputProjectionDatabase();
  try {
    const stored = appendGoalAttachments('Use these mockups', [
      {
        id: 'attachment-1', originalName: 'one.png', storedPath: '/tmp/git-processor/goal-attachments/goal-2467/one.webp',
        mimeType: 'image/webp', size: 10, tokenEstimate: 5, type: 'image' as const,
      },
      {
        id: 'attachment-2', originalName: 'two.png', storedPath: '/tmp/git-processor/goal-attachments/goal-2467/two.webp',
        mimeType: 'image/webp', size: 10, tokenEstimate: 5, type: 'image' as const,
      },
    ]);
    await database('goal_inputs').insert(goalInputRow({ input_id: 'input-1', message: stored }));

    const projected = await serializeGoal(database, emptyRedis, inputGoalRow);

    assert.equal(JSON.stringify(projected).includes('/tmp/git-processor/goal-attachments'), false);
    assert.equal(projected.inputs?.[0].message, 'Use these mockups');
    assert.equal(projected.inputs?.[0].attachmentCount, 2);
  } finally {
    await database.destroy();
  }
});

test('goal projection keeps every persisted correction and never clips a message body', async () => {
  const database = await inputProjectionDatabase();
  try {
    // 65,536 is the longest body the goal input route accepts.
    const longest = 'x'.repeat(65_536);
    const rows = Array.from({ length: 205 }, (_, index) => goalInputRow({
      input_id: `input-${index}`,
      message: index === 204 ? longest : `message ${index}`,
      display_message: index === 204 ? longest : `message ${index}`,
    }));
    await database('goal_inputs').insert(rows);

    const projected = await serializeGoal(database, emptyRedis, inputGoalRow);

    assert.equal(projected.inputs?.length, 205);
    // The oldest correction stays visible however many times the goal has been steered since.
    assert.equal(projected.inputs?.[0].id, 'input-0');
    assert.equal(projected.inputs?.[0].message, 'message 0');
    const last = projected.inputs?.[204];
    assert.equal(last?.id, 'input-204');
    assert.equal(last?.message, longest);
  } finally {
    await database.destroy();
  }
});

test('goal projection leaves an operator-authored preview path in the message untouched', async () => {
  const database = await inputProjectionDatabase();
  try {
    const authored = 'The screenshot at .propr/previews/dashboard.png is stale — recapture it.';
    await database('goal_inputs').insert(goalInputRow({
      input_id: 'input-1', message: authored, display_message: authored, attachment_count: 0,
    }));

    const projected = await serializeGoal(database, emptyRedis, {
      ...inputGoalRow, failure_reason: 'Publishing .propr/previews/dashboard.png failed',
    });

    assert.equal(projected.inputs?.[0].message, authored);
    // Redaction still covers everything ProPR itself writes into the projection.
    assert.equal(projected.failureReason, 'Publishing [local preview omitted] failed');
  } finally {
    await database.destroy();
  }
});

test('goal projection omits inputs entirely for the goal list', async () => {
  const database = await inputProjectionDatabase();
  try {
    await database('goal_inputs').insert(goalInputRow({ input_id: 'input-1', message: 'Focus on the API first' }));

    const listed = await serializeGoal(database, emptyRedis, inputGoalRow, { includeInputs: false });

    assert.equal('inputs' in listed, false);
    assert.equal(JSON.stringify(listed).includes('Focus on the API first'), false);
  } finally {
    await database.destroy();
  }
});

test('goal projection normalizes SQLite timestamps to UTC ISO strings', async () => {
  const database = await inputProjectionDatabase();
  try {
    await database('goal_inputs').insert(goalInputRow({
      input_id: 'input-1', message: 'Ship it', state: 'delivered',
      created_at: '2026-09-22 00:00:01', delivered_at: '2026-09-22 00:00:02',
    }));

    const projected = await serializeGoal(database, emptyRedis, inputGoalRow);

    assert.equal(projected.inputs?.[0].createdAt, '2026-09-22T00:00:01Z');
    assert.equal(projected.inputs?.[0].deliveredAt, '2026-09-22T00:00:02Z');
  } finally {
    await database.destroy();
  }
});
