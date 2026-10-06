import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { simpleGit } from 'simple-git';
import { performConflictResolution } from '../src/git/conflictResolution.js';

const temporaryDirectories: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function configure(git: ReturnType<typeof simpleGit>): Promise<void> {
  await git.addConfig('user.name', 'ProPR Test');
  await git.addConfig('user.email', 'test@propr.dev');
}

async function remoteHead(remote: string, branch: string): Promise<string> {
  return (await simpleGit(remote).raw(['rev-parse', `refs/heads/${branch}`])).trim();
}

/**
 * Builds a bare "GitHub" remote with `main` and a PR branch `feature` that both
 * changed the same line after branching, plus a clone checked out on `feature`.
 */
async function createConflictedPullRequest(): Promise<{ remote: string; worktree: string; prHead: string; baseHead: string }> {
  const remote = await tempDir('propr-conflict-remote-');
  await simpleGit(remote).init(true, ['--initial-branch=main']);

  const seed = await tempDir('propr-conflict-seed-');
  const seedGit = simpleGit(seed);
  await seedGit.clone(remote, seed);
  await configure(seedGit);
  await seedGit.checkout(['-B', 'main']);
  await writeFile(path.join(seed, 'config.ts'), 'export const greeting = "hello";\nexport const other = 1;\n');
  await seedGit.add('.');
  await seedGit.commit('initial');
  await seedGit.push('origin', 'main');

  await seedGit.checkout(['-b', 'feature']);
  await writeFile(path.join(seed, 'config.ts'), 'export const greeting = "hello from the PR";\nexport const other = 1;\n');
  await seedGit.commit('pr change', ['config.ts']);
  await seedGit.push('origin', 'feature');

  // Another PR merges into main and touches the same line.
  await seedGit.checkout('main');
  await writeFile(path.join(seed, 'config.ts'), 'export const greeting = "hello from main";\nexport const other = 1;\n');
  await seedGit.commit('base change', ['config.ts']);
  await seedGit.push('origin', 'main');

  const worktree = await tempDir('propr-conflict-worktree-');
  const git = simpleGit(worktree);
  await git.clone(remote, worktree, ['--branch', 'feature']);
  await configure(git);

  return { remote, worktree, prHead: await remoteHead(remote, 'feature'), baseHead: await remoteHead(remote, 'main') };
}

const RESOLVED = 'export const greeting = "hello from the PR and main";\nexport const other = 1;\n';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test('resolves a genuinely conflicted PR branch into a pushed two-parent merge commit', async () => {
  const { remote, worktree, prHead, baseHead } = await createConflictedPullRequest();
  const seen: string[][] = [];

  const outcome = await performConflictResolution({
    worktreePath: worktree,
    baseBranch: 'main',
    branchName: 'feature',
    expectedHeadSha: prHead,
    commitMessage: 'merge: resolve conflicts from main into feature',
    resolveConflicts: async ({ conflictedFiles }) => {
      seen.push(conflictedFiles);
      const conflicted = await readFile(path.join(worktree, 'config.ts'), 'utf8');
      assert.match(conflicted, /^<<<<<<< /m, 'git left real conflict markers for the resolver');
      await writeFile(path.join(worktree, 'config.ts'), RESOLVED);
      return 'combined both greetings';
    },
  });

  assert.equal(outcome.status, 'resolved');
  assert.deepEqual(seen, [['config.ts']]);
  const newHead = await remoteHead(remote, 'feature');
  assert.notEqual(newHead, prHead, 'the remote PR head advanced');
  assert.equal(outcome.status === 'resolved' && outcome.headSha, newHead);

  const remoteGit = simpleGit(remote);
  const parents = (await remoteGit.raw(['rev-list', '--parents', '-n', '1', newHead])).trim().split(' ').slice(1);
  assert.deepEqual(parents, [prHead, baseHead], 'merge commit parents are the old PR head and the base head');

  const content = await remoteGit.raw(['show', `${newHead}:config.ts`]);
  assert.equal(content, RESOLVED);
  assert.doesNotMatch(content, /^(<<<<<<<|=======|>>>>>>>)/m);

  const mergeBase = (await remoteGit.raw(['merge-base', baseHead, newHead])).trim();
  assert.equal(mergeBase, baseHead, 'the base is now an ancestor of the PR head');
});

test('a resolver that leaves markers yields unresolved, aborts the merge and leaves the remote untouched', async () => {
  const { remote, worktree, prHead } = await createConflictedPullRequest();
  let pushed = false;

  const outcome = await performConflictResolution({
    worktreePath: worktree,
    baseBranch: 'main',
    branchName: 'feature',
    commitMessage: 'merge',
    resolveConflicts: async () => 'did nothing',
    push: async () => { pushed = true; },
  });

  assert.equal(outcome.status, 'unresolved');
  assert.ok(outcome.status === 'unresolved' && outcome.remainingMarkers.length > 0);
  assert.equal(pushed, false);
  assert.equal(await remoteHead(remote, 'feature'), prHead);
  const git = simpleGit(worktree);
  await assert.rejects(git.raw(['rev-parse', '--verify', 'MERGE_HEAD']), 'no merge is left in progress');
  assert.equal((await git.revparse(['HEAD'])).trim(), prHead);
});

test('a failing resolver aborts the merge and rethrows without pushing', async () => {
  const { remote, worktree, prHead } = await createConflictedPullRequest();

  await assert.rejects(performConflictResolution({
    worktreePath: worktree,
    baseBranch: 'main',
    branchName: 'feature',
    commitMessage: 'merge',
    resolveConflicts: async () => { throw new Error('agent crashed'); },
  }), /agent crashed/);

  assert.equal(await remoteHead(remote, 'feature'), prHead);
  const git = simpleGit(worktree);
  await assert.rejects(git.raw(['rev-parse', '--verify', 'MERGE_HEAD']));
  assert.equal((await git.revparse(['HEAD'])).trim(), prHead);
});

test('refuses to touch a worktree whose head is not the expected PR head', async () => {
  const { remote, worktree, prHead } = await createConflictedPullRequest();
  let resolverCalled = false;

  const outcome = await performConflictResolution({
    worktreePath: worktree,
    baseBranch: 'main',
    branchName: 'feature',
    expectedHeadSha: '0'.repeat(40),
    commitMessage: 'merge',
    resolveConflicts: async () => { resolverCalled = true; },
  });

  assert.equal(outcome.status, 'head_moved');
  assert.equal(resolverCalled, false);
  assert.equal(await remoteHead(remote, 'feature'), prHead);
});

test('does not call the resolver or push when the PR already contains the base', async () => {
  const { remote, worktree } = await createConflictedPullRequest();
  // Resolve once so the PR head contains the base.
  await performConflictResolution({
    worktreePath: worktree, baseBranch: 'main', branchName: 'feature', commitMessage: 'merge',
    resolveConflicts: async () => { await writeFile(path.join(worktree, 'config.ts'), RESOLVED); },
  });
  const resolvedHead = await remoteHead(remote, 'feature');
  let resolverCalled = false;

  const outcome = await performConflictResolution({
    worktreePath: worktree, baseBranch: 'main', branchName: 'feature', commitMessage: 'merge',
    resolveConflicts: async () => { resolverCalled = true; },
  });

  assert.equal(outcome.status, 'up_to_date');
  assert.equal(resolverCalled, false);
  assert.equal(await remoteHead(remote, 'feature'), resolvedHead);
});
