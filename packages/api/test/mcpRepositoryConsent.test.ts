import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { buildConsentRepositories, renderConsentRepositories } from '../mcp/repositoryConsent.js';

after(async () => closeConnection());

test('consent metadata preserves the authorized names, including hidden repos, and uses the configured branch icon', () => {
  const repos = buildConsentRepositories(['acme/web', 'acme/api', 'acme/unconfigured'], [
    { name: 'acme/web', enabled: false, baseBranch: 'archived' },
    { name: 'acme/web', enabled: true, baseBranch: 'release' },
    { name: 'acme/api', enabled: true },
    { name: 'private/not-authorized', enabled: true },
  ], [
    { full_name: 'acme/web', branch: 'main', indexing_status: 'completed', last_indexed_at: null, last_indexed_hash: 'wrong-branch', last_indexed_commit_message: null, icon_path: 'wrong.png' },
    { full_name: 'acme/web', branch: 'release', indexing_status: 'completed', last_indexed_at: null, last_indexed_hash: 'abc123', last_indexed_commit_message: null, icon_path: 'public/logo.png' },
  ], { 'acme/web': { starred: true, hidden: true }, 'private/not-authorized': { starred: true } });
  assert.deepEqual(repos, [
    { name: 'acme/web', starred: true, iconPath: 'public/logo.png', iconRevision: 'abc123' },
    { name: 'acme/api', starred: false, iconPath: undefined, iconRevision: 'HEAD' },
    { name: 'acme/unconfigured', starred: false, iconPath: undefined, iconRevision: 'HEAD' },
  ]);
  const html = renderConsentRepositories(repos);
  assert.ok(html.indexOf('Starred') < html.indexOf('value="acme/web"'));
  assert.ok(html.indexOf('value="acme/web"') < html.indexOf('All Repositories'));
  assert.ok(html.includes('https://raw.githubusercontent.com/acme/web/abc123/public/logo.png'));
  assert.ok(!html.includes('private/not-authorized'));
  assert.ok(!html.includes('checked'), 'presentation must not preselect repositories');
});

test('repository metadata is escaped and invalid icons retain the GitHub fallback', () => {
  const html = renderConsentRepositories([{ name: 'acme/<script>alert("x")</script>', iconPath: '../icon.png', starred: true }]);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('repository-icon-fallback'));
});
