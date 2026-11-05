import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGitHubLogin } from '../src/assignment.js';

test('isGitHubLogin accepts logins GitHub allows', () => {
  for (const login of ['octocat', 'o', 'octo-cat', 'a-b-c', 'x'.repeat(39), 'propr-dev[bot]', 'Octo9']) {
    assert.equal(isGitHubLogin(login), true, login);
  }
});

test('isGitHubLogin rejects consecutive, leading and trailing hyphens and overlong logins', () => {
  for (const login of ['octo--cat', 'octocat-', '-octocat', '-', '', 'x'.repeat(40), 'octo cat', 'octocat-[bot]', 'octo_cat']) {
    assert.equal(isGitHubLogin(login), false, login);
  }
});
