import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeConnection } from '@propr/core';
import { orderScopes, relativeTime, renderConnectedApp, renderMcpPage } from '../mcp/browser.js';
import type { McpGrant } from '../mcp/oauth.js';

const grant = (overrides: Partial<McpGrant> = {}): McpGrant => ({
  id: 'grant-1', ownerId: 'user-1', clientId: 'client-1', clientName: 'Claude', instanceId: 'instance',
  resource: 'https://propr.example/api/mcp', scopes: ['read'], repositories: ['integry/mcptest'],
  createdAt: Date.now() - 2 * 3_600_000, expiresAt: Date.now() + 3_600_000, revoked: false, membershipSource: 'local',
  ...overrides,
});
after(() => closeConnection());

const repos = (count: number) => Array.from({ length: count }, (_, index) => `integry/repo-${index + 1}`);

test('scopes follow the canonical family order with unknown scopes last', () => {
  assert.deepEqual(orderScopes(['manage', 'zeta', 'merge', 'read', 'alpha', 'plan', 'read']),
    ['read', 'plan', 'merge', 'manage', 'alpha', 'zeta']);
});

test('relative time is compact', () => {
  const now = Date.UTC(2026, 8, 21, 12);
  assert.equal(relativeTime(now - 30_000, now), 'just now');
  assert.equal(relativeTime(now - 2 * 3_600_000, now), '2h ago');
  assert.equal(relativeTime(now - 30 * 86_400_000, now), '2026-08-22');
});

test('connected app rows are structured, escaped and individually addressable', () => {
  const html = renderConnectedApp(grant({ clientName: 'Claude <b>', scopes: ['merge', 'read', 'plan'] as McpGrant['scopes'] }), '<input name="csrf">');
  assert.match(html, /<h2 title="Claude &lt;b&gt;">Claude &lt;b&gt;<\/h2>/);
  assert.match(html, /aria-label="Revoke access for Claude &lt;b&gt; \(ID: grant-1\)">Revoke access<\/button>/);
  assert.match(html, /Connected 2h ago/);
  assert.match(html, /ID: <span class="chip" title="grant-1">grant-1<\/span>/);
  assert.deepEqual([...html.matchAll(/class="scope">([^<]+)</g)].map(match => match[1]), ['read', 'plan', 'merge']);
  assert.match(html, /<span class="chip" title="integry\/mcptest">integry\/mcptest<\/span>/);
  assert.doesNotMatch(html, /<details/);
});

test('repository lists collapse after ten chips behind a native toggle', () => {
  const html = renderConnectedApp(grant({ repositories: [...repos(25), 'INTEGRY/REPO-1'] }), '');
  const [visible, hidden] = html.slice(html.indexOf('>Repositories<')).split('<details');
  assert.equal(visible.match(/class="chip"/g)?.length, 10);
  assert.equal(hidden.match(/class="chip"/g)?.length, 15);
  assert.match(hidden, /\+ 15 more repositories<\/span><span class="expanded">Show fewer/);
  assert.match(renderConnectedApp(grant({ repositories: repos(11) }), ''), /\+ 1 more repository</);
});

test('only the connected apps page uses the flat, card-free surface', () => {
  assert.match(renderMcpPage('Apps', '', undefined, { flat: true }), /<body class="flat">/);
  assert.doesNotMatch(renderMcpPage('Consent', ''), /<body class="flat">/);
});
