/**
 * Schema probes for the Analytics aggregations, memoised per database.
 *
 * The overview asks about the same optional tables and columns on every
 * request. Only a positive answer is remembered: a table or column that exists
 * stays, while one that is missing may yet arrive with a migration.
 */

import type { Knex } from 'knex';

const present = new WeakMap<Knex, Set<string>>();

async function probe(db: Knex, key: string, check: () => Promise<boolean>): Promise<boolean> {
  let known = present.get(db);
  if (known?.has(key)) return true;
  if (!await check()) return false;
  if (!known) present.set(db, known = new Set());
  known.add(key);
  return true;
}

export const hasTable = (db: Knex, table: string): Promise<boolean> =>
  probe(db, table, () => db.schema.hasTable(table));

export const hasColumn = (db: Knex, table: string, column: string): Promise<boolean> =>
  probe(db, `${table}.${column}`, () => db.schema.hasColumn(table, column));
