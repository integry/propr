import { describe, test } from 'node:test';
import assert from 'node:assert';

import { up } from '../packages/core/src/db/migrations/20260506000000_add_ultrafix_settings_to_plan_issues.js';

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
});
