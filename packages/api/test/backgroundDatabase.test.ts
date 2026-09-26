import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { createBackgroundDatabase } from '../services/backgroundDatabase.js';
import { NotificationProjectionService } from '../services/notificationProjectionService.js';

after(async () => closeConnection());

function createDatabase(filename: string, busyTimeoutMs: number): Knex {
  return knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate(
        connection: { pragma(statement: string): void },
        done: (error: Error | null, connection?: unknown) => void,
      ): void {
        try {
          connection.pragma(`busy_timeout = ${busyTimeoutMs}`);
          connection.pragma('journal_mode = WAL');
          done(null, connection);
        } catch (error) {
          done(error as Error);
        }
      },
    },
  });
}

test('background contention yields while foreground reads stay fresh and account-scoped', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-background-db-'));
  const filename = path.join(directory, 'propr.sqlite');
  const source = createDatabase(filename, 30_000);
  const foreground = createDatabase(filename, 30_000);
  const locking = createDatabase(filename, 0);
  let background: Awaited<ReturnType<typeof createBackgroundDatabase>> | undefined;
  let lockHeld = false;

  try {
    await source.schema.createTable('account_values', table => {
      table.text('user_id').primary();
      table.text('value').notNullable();
    });
    await source.schema.createTable('background_writes', table => {
      table.increments('id').primary();
      table.text('value').notNullable();
    });
    await source('account_values').insert([
      { user_id: 'account-a', value: 'a-before' },
      { user_id: 'account-b', value: 'b-private' },
    ]);

    background = await createBackgroundDatabase(source);
    const timeout = await background.database.raw('PRAGMA busy_timeout') as Array<{
      timeout?: number;
      busy_timeout?: number;
    }>;
    assert.equal(Number(timeout[0]?.timeout ?? timeout[0]?.busy_timeout), 0);

    await locking.raw('BEGIN IMMEDIATE');
    lockHeld = true;
    await locking('account_values')
      .where({ user_id: 'account-a' })
      .update({ value: 'uncommitted' });

    let attempts = 0;
    const projection = new NotificationProjectionService({
      database: background.database,
      contentionRetryDelaysMs: [10, 20, 40, 80, 160],
    });
    const eventLoopTurn = new Promise<void>(resolve => setImmediate(resolve));
    const projectionResult = projection.bestEffort('contention fixture', async () => {
      attempts += 1;
      await background!.database('background_writes').insert({ value: 'projected' });
    });

    // A long busy_timeout here would synchronously pin the API thread before
    // this event-loop turn or either authenticated, user-scoped read can run.
    await Promise.race([
      eventLoopTurn,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('background SQLite contention blocked the event loop')),
        250,
      )),
    ]);
    assert.ok(attempts >= 1);
    assert.equal(
      (await foreground('account_values').where({ user_id: 'account-a' }).first()).value,
      'a-before',
    );
    assert.equal(
      (await foreground('account_values').where({ user_id: 'account-b' }).first()).value,
      'b-private',
    );

    await locking.raw('ROLLBACK');
    lockHeld = false;
    await projectionResult;
    projection.close();
    assert.equal(await foreground('background_writes').count('* as count').first()
      .then(row => Number(row?.count)), 1);

    await foreground('account_values')
      .where({ user_id: 'account-a' })
      .update({ value: 'a-after' });
    assert.equal(
      (await foreground('account_values').where({ user_id: 'account-a' }).first()).value,
      'a-after',
      'foreground reads must not be served from a stale shared cache',
    );
    assert.equal(
      (await foreground('account_values').where({ user_id: 'account-b' }).first()).value,
      'b-private',
      'one account must never receive another account\'s result',
    );
  } finally {
    if (lockHeld) await locking.raw('ROLLBACK').catch(() => undefined);
    await Promise.allSettled([
      background?.close(),
      locking.destroy(),
      foreground.destroy(),
      source.destroy(),
    ]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
