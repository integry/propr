import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260910220000_add_mcp.js';
import { McpStore } from '../mcp/store.js';
import type { McpGrant } from '../mcp/oauth.js';
import { CONNECTED_APPS_PAGE_SIZE, loadConnectedAppsPage } from '../mcp/browser.js';

after(async () => closeConnection());

const NOW = Date.UTC(2026, 10, 14);

async function fixture() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('task_drafts', table => table.string('draft_id').primary());
  await up(db);
  const store = new McpStore(db, randomBytes(32));
  const put = async (index: number, state: 'active' | 'revoked' | 'expired', ownerId = 'owner') => {
    const id = `grant-${String(index).padStart(5, '0')}`;
    const grant: McpGrant = { id, ownerId, clientId: 'client', clientName: `App ${index}`, instanceId: 'instance', resource: 'https://propr.example/api/mcp',
      scopes: ['read'], repositories: ['acme/web-app'], createdAt: NOW - 1000, expiresAt: state === 'expired' ? NOW - 1 : NOW + 60_000, revoked: state === 'revoked', membershipSource: 'fixture' };
    await store.put('grant', id, grant);
    return id;
  };
  return { db, store, put };
}

/** Follows `next` from the first page to the last. */
async function pages(store: McpStore): Promise<string[][]> {
  const result: string[][] = [];
  for (let cursor: string | null = ''; cursor !== null;) {
    const page = await loadConnectedAppsPage({ store }, 'owner', cursor, NOW);
    result.push(page.grants.map(grant => grant.id));
    cursor = page.next;
  }
  return result;
}

test('revoked and expired grants do not take up places on a connected apps page', async () => {
  const { db, store, put } = await fixture();
  // Reconnecting an app leaves its earlier grants stored as revoked or expired:
  // here only every 30th record is still active.
  const active: string[] = [];
  for (let index = 0; index < 180; index++) {
    const state = index % 30 === 0 ? 'active' : index % 2 ? 'revoked' : 'expired';
    const id = await put(index, state);
    if (state === 'active') active.push(id);
  }
  await put(900, 'active', 'someone-else');
  assert.deepEqual(await pages(store), [active], 'the six active apps are one page, not one or two per page');
  await db.destroy();
});

test('a full page is followed by the remaining active apps, without gaps or repeats', async () => {
  const { db, store, put } = await fixture();
  const active: string[] = [];
  for (let index = 0; index < 400; index++) {
    const state = index % 3 === 0 ? 'active' : 'revoked';
    const id = await put(index, state);
    if (state === 'active') active.push(id);
  }
  const listed = await pages(store);
  assert.deepEqual(listed.map(page => page.length), [CONNECTED_APPS_PAGE_SIZE, CONNECTED_APPS_PAGE_SIZE, active.length - 2 * CONNECTED_APPS_PAGE_SIZE]);
  assert.deepEqual(listed.flat(), active);
  await db.destroy();
});

test('exactly one full page of active apps offers no next page', async () => {
  const { db, store, put } = await fixture();
  for (let index = 0; index < CONNECTED_APPS_PAGE_SIZE; index++) await put(index, 'active');
  await put(CONNECTED_APPS_PAGE_SIZE, 'revoked');
  const page = await loadConnectedAppsPage({ store }, 'owner', '', NOW);
  assert.equal(page.grants.length, CONNECTED_APPS_PAGE_SIZE);
  assert.equal(page.next, null);
  await db.destroy();
});
