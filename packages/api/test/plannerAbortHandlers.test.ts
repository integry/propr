import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import knex from 'knex';

process.env.NODE_ENV = 'test';
process.env.PROPR_DEMO_MODE = 'true';

const {
  clearAbortSignal,
  createAbortGenerationHandler,
  createAbortRefinementHandler,
  setAbortSignal,
} = await import('../routes/plannerAbortHandlers.js');
const { closeConnection } = await import('@propr/core');
type AbortRedisFactory = import('../routes/plannerAbortHandlers.js').AbortRedisFactory;

const database = knex({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
});

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      this.body = payload;
      return this;
    },
  };
}

before(async () => {
  await database.schema.createTable('task_drafts', table => {
    table.string('draft_id').primary();
    table.string('user_id').notNullable();
    table.string('status').notNullable();
    table.text('generation_trace');
    table.text('refinement_result');
    table.timestamp('updated_at');
  });
});

beforeEach(async () => {
  await database('task_drafts').delete();
});

after(async () => {
  await database.destroy();
  await closeConnection();
});

describe('planner abort handlers', () => {
  test('preserves a generation that completes before the conditional abort transition', async () => {
    await database('task_drafts').insert({
      draft_id: 'generation-race',
      user_id: 'user-1',
      status: 'generating',
      generation_trace: 'active-run',
      updated_at: '2026-08-03 20:00:00.000',
    });
    let abortSignalCleared = false;
    const handler = createAbortGenerationHandler(database, {
      setAbortSignal: async () => {
        await database('task_drafts').where({ draft_id: 'generation-race' }).update({
          status: 'review',
          generation_trace: 'completed-run',
          updated_at: '2026-08-03 20:00:01.000',
        });
      },
      clearAbortSignal: async () => { abortSignalCleared = true; },
    });
    const response = createResponse();

    await handler({ body: { draftId: 'generation-race' }, user: { id: 'user-1' } } as never, response as never);

    const current = await database('task_drafts').where({ draft_id: 'generation-race' }).first();
    assert.equal(response.statusCode, 409);
    assert.equal(abortSignalCleared, true);
    assert.equal(current.status, 'review');
    assert.equal(current.generation_trace, 'completed-run');
  });

  test('does not cancel a refinement restarted after the abort request read its snapshot', async () => {
    await database('task_drafts').insert({
      draft_id: 'refinement-restart-race',
      user_id: 'user-1',
      status: 'refining',
      refinement_result: 'first-run',
      updated_at: '2026-08-03 20:00:00.000',
    });
    let abortSignalCleared = false;
    const handler = createAbortRefinementHandler(database, {
      setAbortSignal: async () => {
        await database('task_drafts').where({ draft_id: 'refinement-restart-race' }).update({
          status: 'refining',
          refinement_result: 'restarted-run',
          updated_at: '2026-08-03 20:00:02.000',
        });
      },
      clearAbortSignal: async () => { abortSignalCleared = true; },
    });
    const response = createResponse();

    await handler({ body: { draftId: 'refinement-restart-race' }, user: { id: 'user-1' } } as never, response as never);

    const current = await database('task_drafts').where({ draft_id: 'refinement-restart-race' }).first();
    assert.equal(response.statusCode, 409);
    assert.equal(abortSignalCleared, true);
    assert.equal(current.status, 'refining');
    assert.equal(current.refinement_result, 'restarted-run');
  });

  test('reconciles the abort signal when the conditional database transition fails', async t => {
    t.mock.method(console, 'error', () => undefined);
    await database('task_drafts').insert({
      draft_id: 'generation-update-error',
      user_id: 'user-1',
      status: 'generating',
      generation_trace: 'active-run',
      updated_at: '2026-08-03 20:00:00.000',
    });
    await database.raw(`
      CREATE TRIGGER fail_planner_abort
      BEFORE UPDATE ON task_drafts
      WHEN OLD.draft_id = 'generation-update-error'
      BEGIN
        SELECT RAISE(ABORT, 'forced update failure');
      END
    `);
    t.after(async () => {
      await database.raw('DROP TRIGGER IF EXISTS fail_planner_abort');
    });

    let abortSignalCleared = false;
    const handler = createAbortGenerationHandler(database, {
      setAbortSignal: async () => undefined,
      clearAbortSignal: async () => { abortSignalCleared = true; },
    });
    const response = createResponse();

    await handler({ body: { draftId: 'generation-update-error' }, user: { id: 'user-1' } } as never, response as never);

    const current = await database('task_drafts').where({ draft_id: 'generation-update-error' }).first();
    assert.equal(response.statusCode, 500);
    assert.equal(abortSignalCleared, true);
    assert.equal(current.status, 'generating');
    assert.equal(current.generation_trace, 'active-run');
  });

  test('closes Redis connections when setting or clearing an abort signal fails', async () => {
    for (const operation of [
      (factory: AbortRedisFactory) => setAbortSignal('draft-1', factory),
      (factory: AbortRedisFactory) => clearAbortSignal('draft-1', factory),
    ]) {
      let quitCalls = 0;
      const factory = () => ({
        del: async () => { throw new Error('del failed'); },
        setex: async () => { throw new Error('setex failed'); },
        quit: async () => { quitCalls += 1; },
        disconnect: () => undefined,
      });

      await assert.rejects(operation(factory));
      assert.equal(quitCalls, 1);
    }
  });

  test('disconnects Redis when graceful shutdown fails', async t => {
    t.mock.method(console, 'error', () => undefined);
    let disconnectCalls = 0;
    await clearAbortSignal('draft-1', () => ({
      del: async () => 1,
      setex: async () => 'OK',
      quit: async () => { throw new Error('quit failed'); },
      disconnect: () => { disconnectCalls += 1; },
    }));

    assert.equal(disconnectCalls, 1);
  });
});
