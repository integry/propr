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
let rewrittenCommit: string;

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
    // A branch rewritten to history that no longer contains the policy commit (force-push).
    await git.checkout(['--orphan', 'rewritten']);
    await writeFile(path.join(seed, 'state.txt'), 'rewritten');
    await git.add('.').commit('unrelated commit');
    rewrittenCommit = (await git.revparse(['HEAD'])).trim();
    await git.push('origin', 'rewritten');
    // An epic branch created after its policy fell back to the default branch.
    await git.checkout(['-b', 'epic', 'main']).push('origin', 'epic');
    // Cloning or refreshing the repository makes the new branch visible to worktree creation.
    await simpleGit(clone).fetch(['origin']);
});

after(() => rm(root, { recursive: true, force: true }));

const create = (startRevision: { branch: string; revision: string } | null, baseBranch = 'main') => createWorktreeForIssue(clone,
    { issueId: 42, issueTitle: 'Fix', owner: 'owner', repoName: 'repo' }, { baseBranch, startRevision });

const head = async (worktreePath: string) => (await simpleGit(worktreePath).revparse(['HEAD'])).trim();

test('an issue worktree starts from the commit its workflow policy was read from', async () => {
    const { worktreePath } = await create({ branch: 'main', revision: policyCommit });
    assert.equal(await head(worktreePath), policyCommit);
    assert.equal(await readFile(path.join(worktreePath, 'state.txt'), 'utf8'), 'policy');
});

test('without a workflow policy the worktree starts from the fetched branch head', async () => {
    const { worktreePath } = await create(null);
    assert.equal(await head(worktreePath), headCommit);
});

test('a policy read from the default branch for a missing base starts from its commit on the default branch', async () => {
    const { worktreePath } = await create({ branch: 'main', revision: policyCommit }, 'missing-epic');
    assert.equal(await head(worktreePath), policyCommit);
});

test('a base that moved away from the policy commit stops preparation instead of checking out other code', async (t) => {
    const cases: Array<[string, { branch: string; revision: string }, string]> = [
        ['force-pushed base', { branch: 'rewritten', revision: policyCommit }, 'rewritten'],
        ['base appeared after the policy fell back to the default branch', { branch: 'main', revision: policyCommit }, 'epic'],
        ['policy read from another branch', { branch: 'release', revision: policyCommit }, 'main'],
        ['unknown policy commit', { branch: 'main', revision: 'f'.repeat(40) }, 'main'],
        ['malformed policy commit', { branch: 'main', revision: 'main' }, 'main'],
    ];
    for (const [name, startRevision, baseBranch] of cases) {
        await t.test(name, async () => {
            await assert.rejects(create(startRevision, baseBranch), /repository workflow revision/);
        });
    }
    // Sanity: each rejected base exists and could have been checked out without a policy.
    assert.equal(await head((await create(null, 'rewritten')).worktreePath), rewrittenCommit);
    assert.equal(await head((await create(null, 'epic')).worktreePath), headCommit);
});
