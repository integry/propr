import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import {
  claimDraftOperation,
  hasRunningPlannerContainer,
  isDraftOperationActive
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

describe('planner operation guard', () => {
  test('recognizes statuses that represent active draft work', () => {
    assert.equal(isDraftOperationActive('generating'), true);
    assert.equal(isDraftOperationActive('refining'), true);
    assert.equal(isDraftOperationActive('executing'), true);
    assert.equal(isDraftOperationActive('review'), false);
  });

  test('atomically allows only one operation to claim a draft', async () => {
    await database.schema.createTable('task_drafts', (table) => {
      table.string('draft_id').primary();
      table.string('user_id').notNullable();
      table.string('status');
      table.timestamp('updated_at');
      table.text('generation_trace');
    });
    await database('task_drafts').insert({ draft_id: 'draft-12345678', user_id: 'user-1', status: 'review' });

    const claims = await Promise.all([
      claimDraftOperation(database, 'draft-12345678', 'generating'),
      claimDraftOperation(database, 'draft-12345678', 'generating')
    ]);

    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await claimDraftOperation(database, 'draft-12345678', 'refining'), false);
    assert.equal((await database('task_drafts').where({ draft_id: 'draft-12345678' }).first()).status, 'generating');
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
