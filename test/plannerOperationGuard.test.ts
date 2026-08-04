import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import {
  claimDraftPreparation,
  claimDraftOperation,
  hasRunningPlannerContainer,
  isDraftOperationActive,
  releaseDraftPreparation,
  recoverStaleRefinement
} from '../packages/api/routes/plannerHelpers/operationGuard.js';

const database = knex({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true
});

after(async () => {
  await database.destroy();
  await closeConnection();
});

before(async () => {
  await database.schema.createTable('task_drafts', (table) => {
    table.string('draft_id').primary();
    table.string('user_id').notNullable();
    table.string('status');
    table.timestamp('updated_at');
    table.text('generation_trace');
    table.text('refinement_result');
  });
});

describe('planner operation guard', () => {
  test('recognizes statuses that represent active draft work', () => {
    assert.equal(isDraftOperationActive('generating'), true);
    assert.equal(isDraftOperationActive('refining'), true);
    assert.equal(isDraftOperationActive('executing'), true);
    assert.equal(isDraftOperationActive('review'), false);
  });

  test('atomically allows only one operation to claim a draft', async () => {
    await database('task_drafts').insert({ draft_id: 'draft-12345678', user_id: 'user-1', status: 'review' });

    const claims = await Promise.all([
      claimDraftOperation(database, 'draft-12345678', 'generating'),
      claimDraftOperation(database, 'draft-12345678', 'generating')
    ]);

    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await claimDraftOperation(database, 'draft-12345678', 'refining'), false);
    assert.equal((await database('task_drafts').where({ draft_id: 'draft-12345678' }).first()).status, 'generating');
  });

  test('prevents preview and generation setup from overlapping', () => {
    assert.equal(claimDraftPreparation('preparing-draft', 'context-preview'), true);
    assert.equal(claimDraftPreparation('preparing-draft', 'plan-generation'), false);

    // A stale cleanup from another operation must not release the active owner.
    releaseDraftPreparation('preparing-draft', 'plan-generation');
    assert.equal(claimDraftPreparation('preparing-draft', 'plan-refinement'), false);

    releaseDraftPreparation('preparing-draft', 'context-preview');
    assert.equal(claimDraftPreparation('preparing-draft', 'plan-generation'), true);
    releaseDraftPreparation('preparing-draft', 'plan-generation');
  });

  test('recovers a stale refinement as a visible failure', async () => {
    const now = new Date('2026-08-01T12:00:00.000Z');
    await database('task_drafts').insert({
      draft_id: 'stale-refinement',
      user_id: 'user-1',
      status: 'refining',
      updated_at: '2026-08-01 11:20:00',
      refinement_result: JSON.stringify({ status: 'in_progress' })
    });

    const draft = await database('task_drafts').where({ draft_id: 'stale-refinement' }).first();
    const recovered = await recoverStaleRefinement(database, draft, { now });
    const result = JSON.parse(recovered.refinement_result as string);

    assert.equal(recovered.status, 'review');
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'Refinement stopped before completion. Please try again.');
    assert.equal(result.timestamp, now.toISOString());
  });

  test('does not release a fresh refinement', async () => {
    const now = new Date('2026-08-01T12:00:00.000Z');
    const refinementResult = JSON.stringify({ status: 'in_progress' });
    await database('task_drafts').insert({
      draft_id: 'fresh-refinement',
      user_id: 'user-1',
      status: 'refining',
      updated_at: '2026-08-01 11:30:00.001',
      refinement_result: refinementResult
    });

    const draft = await database('task_drafts').where({ draft_id: 'fresh-refinement' }).first();
    const unchanged = await recoverStaleRefinement(database, draft, { now });

    assert.equal(unchanged.status, 'refining');
    assert.equal(unchanged.refinement_result, refinementResult);
  });

  test('detects a legacy running container by operation and draft suffix', async () => {
    let observedArgs: string[] = [];
    const running = await hasRunningPlannerContainer(
      'draft-12345678',
      'plan-generation',
      async (_command, args) => {
        observedArgs = args;
        return {
          exitCode: 0,
          stdout: 'ffeeceebf178\n',
          stderr: '',
          messageTimestamps: new Map<string, string>()
        };
      }
    );

    assert.equal(running, true);
    assert.deepEqual(observedArgs, [
      'ps',
      '--filter', 'name=plan-generation-12345678',
      '--format', '{{.ID}}'
    ]);
  });
});
