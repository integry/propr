import assert from 'node:assert/strict';
import test from 'node:test';
import knex from 'knex';
import { up as createDesktopAuth } from '../src/db/migrations/20260829000000_create_desktop_auth.js';
import {
  down as rollbackTwoPhaseDesktopAuth,
  up as addTwoPhaseDesktopAuth,
} from '../src/db/migrations/20260830000000_add_two_phase_desktop_pairing.js';

test('adds two-phase state without changing existing active credentials and rolls it back', async () => {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  try {
    await createDesktopAuth(database);
    await database('instance_api_tokens').insert({
      id: 'token-id',
      token_hash: 'hash',
      token_hint: 'hint',
      name: 'Existing desktop',
      owner_github_user_id: '1',
      owner_github_username: 'owner',
      owner_display_name: 'Owner',
      created_at: '2026-08-30T00:00:00.000Z',
    });

    await addTwoPhaseDesktopAuth(database);
    const migrated = await database('instance_api_tokens').where({ id: 'token-id' }).first();
    assert.equal(migrated.activation_state, 'active');
    assert.equal(migrated.pairing_id, null);
    assert.equal(await database.schema.hasColumn('desktop_pairing_requests', 'activation_ticket_hash'), true);

    await rollbackTwoPhaseDesktopAuth(database);
    assert.equal(await database.schema.hasColumn('instance_api_tokens', 'activation_state'), false);
    assert.equal(await database.schema.hasColumn('desktop_pairing_requests', 'activation_ticket_hash'), false);
    assert.notEqual(await database('instance_api_tokens').where({ id: 'token-id' }).first(), undefined);
  } finally {
    await database.destroy();
  }
});
