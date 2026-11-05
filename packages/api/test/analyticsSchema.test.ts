import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import { forgetSchemaProbes, hasColumn, hasTable } from '../routes/analyticsSchema.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
after(async () => database.destroy());

test('a positive answer is remembered until the probes are forgotten; a negative one is asked again', async () => {
  assert.equal(await hasTable(database, 'scores'), false);
  assert.equal(await hasColumn(database, 'scores', 'score'), false);

  // A migration arrives: the next probe sees it.
  await database.schema.createTable('scores', table => { table.integer('score'); });
  assert.equal(await hasTable(database, 'scores'), true);
  assert.equal(await hasColumn(database, 'scores', 'score'), true);

  // The memo never invalidates on its own: a table dropped on the same
  // connection is still remembered as present.
  await database.schema.dropTable('scores');
  assert.equal(await hasTable(database, 'scores'), true);
  assert.equal(await hasColumn(database, 'scores', 'score'), true);

  forgetSchemaProbes(database);
  assert.equal(await hasTable(database, 'scores'), false);
  assert.equal(await hasColumn(database, 'scores', 'score'), false);

  // Forgetting every database covers this one too.
  await database.schema.createTable('scores', table => { table.integer('score'); });
  assert.equal(await hasTable(database, 'scores'), true);
  await database.schema.dropTable('scores');
  forgetSchemaProbes();
  assert.equal(await hasTable(database, 'scores'), false);
});
