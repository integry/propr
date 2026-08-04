import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import knex from 'knex';

const database = knex({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
});

await database.schema.createTable('task_drafts', table => {
  table.string('draft_id').primary();
  table.string('status').notNullable();
  table.text('generation_trace');
  table.timestamp('updated_at');
});

await mock.module('../packages/core/src/db/connection.js', {
  namedExports: { db: database },
});

const publishDraftUpdate = mock.fn(async () => true);
await mock.module('../packages/core/src/utils/eventPublisher.js', {
  namedExports: {
    getEventPublisher: () => ({ publishDraftUpdate }),
  },
});

const { updateTraceForRun } = await import('../packages/core/src/services/planning/traceService.js');

after(async () => {
  await database.destroy();
});

test('run-scoped trace updates include step data and reject stale runs', async () => {
  const draftId = 'trace-run-isolation';
  const firstRunId = 'generation-run-1';
  await database('task_drafts').insert({
    draft_id: draftId,
    status: 'generating',
    generation_trace: JSON.stringify({ steps: [], runId: firstRunId }),
  });

  await updateTraceForRun(draftId, 'context', 'in_progress', {
    expectedRunId: firstRunId,
    data: { fileCount: 4 },
  });
  const firstTrace = JSON.parse((await database('task_drafts').where({ draft_id: draftId }).first()).generation_trace);
  assert.deepEqual(firstTrace, {
    steps: [{ name: 'context', status: 'in_progress', data: { fileCount: 4 } }],
    runId: firstRunId,
  });

  const replacementTrace = JSON.stringify({ steps: [], runId: 'generation-run-2' });
  await database('task_drafts').where({ draft_id: draftId }).update({ generation_trace: replacementTrace });

  await assert.rejects(
    updateTraceForRun(draftId, 'context', 'completed', {
      expectedRunId: firstRunId,
      data: { tokenCount: 100 },
    }),
    /Planner generation run generation-run-1 is no longer active/,
  );
  const current = await database('task_drafts').where({ draft_id: draftId }).first();
  assert.equal(current.generation_trace, replacementTrace);
  assert.equal(publishDraftUpdate.mock.callCount(), 1);
  const published = publishDraftUpdate.mock.calls[0].arguments[0];
  assert.equal(published.runId, firstRunId);
  assert.equal(published.generationTrace.runId, firstRunId);
});
