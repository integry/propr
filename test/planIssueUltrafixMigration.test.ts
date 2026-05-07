import { describe, test } from 'node:test';
import assert from 'node:assert';

import { down, up } from '../packages/core/src/db/migrations/20260506000000_add_ultrafix_settings_to_plan_issues.js';

describe('plan issue ultrafix migration', () => {
  test('adds SQLite columns with inline check constraints', async () => {
    const rawCalls: string[] = [];
    const knex = {
      client: {
        config: {
          client: 'sqlite3',
        },
      },
      raw: async (sql: string) => {
        rawCalls.push(sql);
      },
      schema: {
        alterTable: async () => {
          throw new Error('alterTable should not be used for sqlite constraints');
        },
      },
    };

    await up(knex as never);

    assert.deepStrictEqual(rawCalls, [
      'ALTER TABLE plan_issues ADD COLUMN run_ultrafix boolean NULL',
      'ALTER TABLE plan_issues ADD COLUMN ultrafix_goal integer NULL CHECK (ultrafix_goal IS NULL OR ultrafix_goal BETWEEN 1 AND 10)',
      'ALTER TABLE plan_issues ADD COLUMN ultrafix_max_cycles integer NULL CHECK (ultrafix_max_cycles IS NULL OR ultrafix_max_cycles >= 1)',
    ]);
  });

  test('adds PostgreSQL constraints explicitly after adding columns', async () => {
    const rawCalls: string[] = [];
    const columnCalls: string[] = [];
    const knex = {
      client: {
        config: {
          client: 'pg',
        },
      },
      raw: async (sql: string) => {
        rawCalls.push(sql.trim());
      },
      schema: {
        alterTable: async (_tableName: string, callback: (table: {
          boolean: (name: string) => { nullable: () => void };
          integer: (name: string) => { nullable: () => void };
        }) => void) => {
          const table = {
            boolean: (name: string) => ({
              nullable: () => {
                columnCalls.push(`boolean:${name}`);
              }
            }),
            integer: (name: string) => ({
              nullable: () => {
                columnCalls.push(`integer:${name}`);
              }
            })
          };
          callback(table);
        },
      },
    };

    await up(knex as never);

    assert.deepStrictEqual(columnCalls, [
      'boolean:run_ultrafix',
      'integer:ultrafix_goal',
      'integer:ultrafix_max_cycles',
    ]);
    assert.deepStrictEqual(rawCalls, [
      'ALTER TABLE plan_issues\n      ADD CONSTRAINT chk_plan_issues_ultrafix_goal\n      CHECK (ultrafix_goal IS NULL OR ultrafix_goal BETWEEN 1 AND 10)',
      'ALTER TABLE plan_issues\n      ADD CONSTRAINT chk_plan_issues_ultrafix_max_cycles\n      CHECK (ultrafix_max_cycles IS NULL OR ultrafix_max_cycles >= 1)',
    ]);
  });

  test('rejects unsupported non-SQLite, non-PostgreSQL dialects explicitly', async () => {
    const knex = {
      client: {
        config: {
          client: 'mysql2',
        },
      },
      raw: async () => {
        throw new Error('raw should not be called');
      },
      schema: {
        alterTable: async () => {
          throw new Error('alterTable should not be called');
        },
      },
    };

    await assert.rejects(
      up(knex as never),
      /Unsupported database dialect for plan_issues ultrafix migration: mysql2/
    );
    await assert.rejects(
      down(knex as never),
      /Unsupported database dialect for plan_issues ultrafix migration rollback: mysql2/
    );
  });
});
