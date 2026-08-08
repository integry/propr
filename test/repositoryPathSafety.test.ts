import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  assertGitHubRepositoryIdentity,
  assertGitHubRepositoryUrl,
  assertRepositoryClonePath,
  resolveRepositoryClonePath,
  resolveRepositoryWorktreePath,
} from '../packages/core/src/git/repositoryPaths.js';

test('repository clone paths remain beneath their configured root', () => {
  const root = '/tmp/propr-clones';
  assert.equal(
    resolveRepositoryClonePath(root, 'integry', 'propr'),
    path.join(root, 'integry', 'propr'),
  );
  assertRepositoryClonePath(path.join(root, 'integry', 'propr'), root, 'integry', 'propr');
  assert.throws(
    () => assertRepositoryClonePath('/tmp/other/propr', root, 'integry', 'propr'),
    /does not match/,
  );
});

test('repository identities reject dot segments and path separators', () => {
  assert.doesNotThrow(() => assertGitHubRepositoryIdentity('valid-owner', '.github'));
  for (const [owner, repo] of [
    ['..', 'repo'],
    ['owner', '..'],
    ['owner/name', 'repo'],
    ['owner', '../repo'],
    ['owner', '..\\repo'],
  ]) {
    assert.throws(() => assertGitHubRepositoryIdentity(owner, repo), /Invalid GitHub/);
  }
});

test('authenticated clone URLs must exactly match the validated repository', () => {
  assert.doesNotThrow(() => assertGitHubRepositoryUrl(
    'https://github.com/integry/propr.git',
    'integry',
    'propr',
  ));
  assert.throws(
    () => assertGitHubRepositoryUrl('https://evil.example/integry/propr.git', 'integry', 'propr'),
    /does not match/,
  );
  assert.throws(
    () => assertGitHubRepositoryUrl('https://github.com/integry/other.git', 'integry', 'propr'),
    /does not match/,
  );
});

test('worktree paths accept one safe directory segment only', () => {
  const root = '/tmp/propr-worktrees';
  assert.equal(
    resolveRepositoryWorktreePath(root, 'integry', 'propr', 'issue-42-codex:gpt-5'),
    path.join(root, 'integry', 'propr', 'issue-42-codex:gpt-5'),
  );
  for (const segment of ['..', '../issue-42', 'nested/issue-42', 'nested\\issue-42', 'bad\nname']) {
    assert.throws(
      () => resolveRepositoryWorktreePath(root, 'integry', 'propr', segment),
      /Invalid worktree/,
    );
  }
});
