import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

// Repository paths are fixed at import time.
const root = await mkdtemp(path.join(tmpdir(), 'propr-start-revision-'));
process.env.GIT_CLONES_BASE_PATH = path.join(root, 'clones');
process.env.GIT_WORKTREES_BASE_PATH = path.join(root, 'worktrees');
process.env.HOME = root;
// Worktree setup hands the checkout to UID 1000 through sudo, which CI runners
// allow; the runner could then no longer delete the worktrees afterwards.
const bin = path.join(root, 'bin');
await mkdir(bin);
await writeFile(path.join(bin, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const { createWorktreeForIssue } = await import('../packages/core/src/git/repoManager.js');

const remote = path.join(root, 'remote.git');
const clone = path.join(root, 'clones', 'owner', 'repo');
let policyCommit: string;
let headCommit: string;

before(async () => {
    await simpleGit().raw(['init', '--bare', '--initial-branch=main', remote]);
    const seed = path.join(root, 'seed');
    await mkdir(seed);
    const git = simpleGit(seed);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'ProPR Test');
    await git.addConfig('user.email', 'test@propr.dev');
    await writeFile(path.join(seed, 'state.txt'), 'policy');
    await git.add('.').commit('policy commit');
    policyCommit = (await git.revparse(['HEAD'])).trim();
    await git.addRemote('origin', remote).push('origin', 'main');
    await mkdir(path.dirname(clone), { recursive: true });
    await simpleGit().clone(remote, clone);
    // The base branch advances after the policy was read.
    await writeFile(path.join(seed, 'state.txt'), 'advanced');
    await git.add('.').commit('advanced commit');
    headCommit = (await git.revparse(['HEAD'])).trim();
    await git.push('origin', 'main');
});

after(() => rm(root, { recursive: true, force: true }));

const create = (startRevision: { branch: string; revision: string } | null) => createWorktreeForIssue(clone,
    { issueId: 42, issueTitle: 'Fix', owner: 'owner', repoName: 'repo' }, { baseBranch: 'main', startRevision });

test('an issue worktree starts from the commit its workflow policy was read from', async () => {
    const { worktreePath } = await create({ branch: 'main', revision: policyCommit });
    assert.equal((await simpleGit(worktreePath).revparse(['HEAD'])).trim(), policyCommit);
    assert.equal(await readFile(path.join(worktreePath, 'state.txt'), 'utf8'), 'policy');
});

test('without a usable policy commit the worktree starts from the fetched branch head', async () => {
    for (const startRevision of [null, { branch: 'release', revision: policyCommit }, { branch: 'main', revision: 'f'.repeat(40) }]) {
        const { worktreePath } = await create(startRevision);
        assert.equal((await simpleGit(worktreePath).revparse(['HEAD'])).trim(), headCommit, JSON.stringify(startRevision));
    }
});
