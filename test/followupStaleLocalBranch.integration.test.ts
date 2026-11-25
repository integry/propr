import { test, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { simpleGit, type SimpleGit } from 'simple-git';

// A follow-up on an existing PR branch must not fail at worktree creation with
// "a branch named … already exists" because an earlier run of the same PR left
// a local branch (or a worktree registration) behind (#3687).

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-followup-stale-branch-'));
process.env.GIT_CLONES_BASE_PATH = path.join(root, 'clones');
process.env.GIT_WORKTREES_BASE_PATH = path.join(root, 'worktrees');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
delete process.env.SSH_ASKPASS;
const bin = path.join(root, 'bin');
await fs.ensureDir(bin);
await fs.writeFile(path.join(bin, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: () => { throw new Error('no database in this suite'); } } });
const { addWorktreeWithoutTracking } = await import('../packages/core/src/git/worktreeCreation.js');
const { createWorktreeFromExistingBranch } = await import('../packages/core/src/git/repoManager.js');
const { OBJECT_REPAIR_MARKER, RepositoryRepairRequiredError } = await import('../packages/core/src/git/repositoryPreparation.js');

const BRANCH = '3621/claude-opus-5-5-stale-branch';
let serial = 0;
let repoName: string;
let clone: string;
let remote: string;
let git: SimpleGit;
let author: SimpleGit;
let authorDir: string;

after(() => fs.remove(root));

async function commitIn(repo: SimpleGit, dir: string, file: string, content: string): Promise<string> {
    await fs.writeFile(path.join(dir, file), content);
    await repo.add(file).commit(`${file}: ${content}`);
    return (await repo.revparse(['HEAD'])).trim();
}

beforeEach(async () => {
    repoName = `repo-${++serial}`;
    remote = path.join(root, `remote-${serial}.git`);
    await simpleGit().raw(['init', '--bare', '--initial-branch=main', remote]);
    // A separate checkout plays the PR author pushing to the PR branch.
    authorDir = path.join(root, `author-${serial}`);
    await simpleGit().clone(remote, authorDir);
    author = simpleGit(authorDir);
    await author.addConfig('user.name', 'Author').addConfig('user.email', 'author@example.com');
    await commitIn(author, authorDir, 'tracked', 'initial');
    await author.push('origin', 'HEAD:refs/heads/main');
    await author.push('origin', `HEAD:refs/heads/${BRANCH}`);

    clone = path.join(root, 'clones', 'owner', repoName);
    await fs.ensureDir(path.dirname(clone));
    await simpleGit().clone(remote, clone);
    git = simpleGit(clone);
    await git.addConfig('user.name', 'Worker').addConfig('user.email', 'worker@example.com');
    await git.fetch('origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
});

const followup = (dir: string) => createWorktreeFromExistingBranch(clone, BRANCH, { owner: 'owner', repoName, worktreeDirName: dir });
const head = async (dir: string) => (await simpleGit(dir).revparse(['HEAD'])).trim();
const branchTip = async () => (await git.revparse([`refs/heads/${BRANCH}`])).trim();

/** Leaves the local branch behind the way an earlier, finished run does: no worktree holds it. */
async function staleLocalBranch(at = `origin/${BRANCH}`) {
    await git.raw(['branch', '--no-track', BRANCH, at]);
}

test('a stale local branch equal to the remote head is reused', async () => {
    await staleLocalBranch();
    const remoteHead = (await git.revparse([`origin/${BRANCH}`])).trim();
    const result = await followup('equal');
    assert.equal(result.branchName, BRANCH);
    assert.equal(await head(result.worktreePath), remoteHead);
    assert.equal((await simpleGit(result.worktreePath).raw(['branch', '--show-current'])).trim(), BRANCH);
});

test('a stale local branch behind the remote is fast-forwarded to the fetched remote head', async () => {
    await staleLocalBranch();
    const pushed = await commitIn(author, authorDir, 'tracked', 'pushed by the author');
    await author.push('origin', `HEAD:refs/heads/${BRANCH}`);
    const result = await followup('behind');
    assert.equal(await head(result.worktreePath), pushed);
    assert.equal(await branchTip(), pushed);
    assert.equal((await git.raw(['for-each-ref', 'refs/propr/superseded/'])).trim(), '', 'nothing to back up');
});

/** The refusal #3687 requires: it names the branch and the run stops before Git creates anything. */
function refusesNamingBranch(error: Error): boolean {
    assert.ok(error.message.includes(`Local branch '${BRANCH}'`), error.message);
    assert.match(error.message, /not on origin\//);
    assert.doesNotMatch(error.message, /already exists/);
    return true;
}
const supersededBackups = async () => (await git.raw(['for-each-ref', 'refs/propr/superseded/'])).trim();

test('a stale local branch with unpushed commits fails the run with a message naming the branch and changes nothing', async () => {
    // An earlier run committed locally and never pushed.
    const first = await followup('first');
    const unpushed = await commitIn(simpleGit(first.worktreePath), first.worktreePath, 'tracked', 'unpushed');
    await simpleGit(first.worktreePath).raw(['checkout', '--detach']);
    await fs.remove(first.worktreePath);
    await git.raw(['worktree', 'prune']);

    await assert.rejects(followup('ahead'), refusesNamingBranch);
    assert.equal(await branchTip(), unpushed, 'the unpushed commit is still the branch tip');
    assert.equal(await supersededBackups(), '', 'nothing was reset behind a backup');
    assert.equal(await fs.pathExists(path.join(root, 'worktrees', 'owner', repoName, 'ahead')), false);
    assert.doesNotMatch(await git.raw(['worktree', 'list', '--porcelain']), new RegExp(`branch refs/heads/${BRANCH}`));
});

test('a stale branch diverged from a force-pushed remote fails the run naming the branch instead of being reset', async () => {
    await staleLocalBranch();
    const scratch = path.join(root, `scratch-${serial}`);
    await git.raw(['worktree', 'add', scratch, BRANCH]);
    const local = await commitIn(simpleGit(scratch), scratch, 'tracked', 'local only');
    await simpleGit(scratch).raw(['checkout', '--detach']);
    await author.raw(['commit', '--amend', '-m', 'rewritten']);
    await author.push(['--force', 'origin', `HEAD:refs/heads/${BRANCH}`]);

    await assert.rejects(followup('diverged'), refusesNamingBranch);
    assert.equal(await branchTip(), local, 'the local-only commit is still the branch tip');
    assert.equal(await supersededBackups(), '');
    assert.equal(await fs.pathExists(path.join(root, 'worktrees', 'owner', repoName, 'diverged')), false);
});

test('a branch held by a worktree registration whose directory is gone is released and reused', async () => {
    const first = await followup('gone');
    const tip = await head(first.worktreePath);
    // The directory disappears without `git worktree remove`; pruning is off for the worker.
    await fs.remove(first.worktreePath);
    assert.match(await git.raw(['worktree', 'list', '--porcelain']), new RegExp(`branch refs/heads/${BRANCH}`));

    const retry = await followup('after-gone');
    assert.equal(await head(retry.worktreePath), tip);
    assert.equal((await simpleGit(retry.worktreePath).raw(['branch', '--show-current'])).trim(), BRANCH);
});

test('a stale registration of the same worktree path whose directory is gone is cleared', async () => {
    const first = await followup('same-path');
    const tip = await head(first.worktreePath);
    await simpleGit(first.worktreePath).raw(['checkout', '--detach']);
    await fs.remove(first.worktreePath);

    const retry = await followup('same-path');
    assert.equal(retry.worktreePath, first.worktreePath);
    assert.equal(await head(retry.worktreePath), tip);
});

test('an unrecoverable local branch tip is reported by ref name and the branch is preserved', async () => {
    const tip = 'f'.repeat(40);
    const ref = path.join(clone, '.git', 'refs', 'heads', ...BRANCH.split('/'));
    await fs.ensureDir(path.dirname(ref));
    await fs.writeFile(ref, `${tip}\n`);
    await assert.rejects(followup('missing-tip'), error => {
        assert.ok(error instanceof RepositoryRepairRequiredError);
        assert.ok(error.message.includes(`refs/heads/${BRANCH}`), error.message);
        assert.doesNotMatch(error.message, /already exists/);
        return true;
    });
    const marker = path.join(clone, '.git', OBJECT_REPAIR_MARKER);
    const incident = await fs.readFile(marker, 'utf8');
    assert.equal(JSON.parse(incident).revision, tip);
    const worktreePath = path.join(root, `missing-tip-${serial}`);
    await assert.rejects(
        addWorktreeWithoutTracking(git, worktreePath, BRANCH, { startPoint: `origin/${BRANCH}`, resetBranch: true }),
        error => {
            assert.ok(error instanceof RepositoryRepairRequiredError);
            assert.match(error.message, /previous automatic repair failed/);
            assert.ok(error.message.includes(`refs/heads/${BRANCH}`), error.message);
            return true;
        },
    );
    assert.equal(await fs.readFile(marker, 'utf8'), incident);
    assert.equal(await fs.pathExists(path.join(root, 'worktrees', 'owner', repoName, 'missing-tip')), false);
    assert.equal(await fs.pathExists(worktreePath), false);
    assert.equal(await fs.readFile(ref, 'utf8'), `${tip}\n`);
});

test('a branch Git refuses to create as already existing is reused instead of failing', async () => {
    await staleLocalBranch();
    const remoteHead = (await git.revparse([`origin/${BRANCH}`])).trim();
    // The existence check runs `rev-parse --verify --quiet refs/heads/<branch>`.
    // Make the first check miss the branch, as the listing-based check did in
    // production, so only the fallback on Git's refusal can reuse it.
    let missed = false;
    const fooled = new Proxy(git, {
        get(target, property, receiver) {
            if (property !== 'raw') return Reflect.get(target, property, receiver);
            return (args: string[]) => {
                if (!missed && args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${BRANCH}`) {
                    missed = true;
                    return Promise.resolve('');
                }
                return target.raw(args);
            };
        },
    });
    const worktreePath = path.join(root, `fallback-${serial}`);
    await addWorktreeWithoutTracking(fooled, worktreePath, BRANCH, { startPoint: `origin/${BRANCH}`, resetBranch: true });
    assert.ok(missed);
    assert.equal(await head(worktreePath), remoteHead);
    // A fresh-branch caller still refuses an existing branch.
    await assert.rejects(
        addWorktreeWithoutTracking(git, path.join(root, `fresh-${serial}`), 'main', { startPoint: 'main' }),
        /already exists/,
    );
});

test('a branch Git refuses as already existing is refused, not reused, when it carries unpushed commits', async () => {
    await staleLocalBranch();
    const scratch = path.join(root, `scratch-${serial}`);
    await git.raw(['worktree', 'add', scratch, BRANCH]);
    const unpushed = await commitIn(simpleGit(scratch), scratch, 'tracked', 'unpushed');
    await simpleGit(scratch).raw(['checkout', '--detach']);
    let missed = false;
    const fooled = new Proxy(git, {
        get(target, property, receiver) {
            if (property !== 'raw') return Reflect.get(target, property, receiver);
            return (args: string[]) => {
                if (!missed && args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${BRANCH}`) {
                    missed = true;
                    return Promise.resolve('');
                }
                return target.raw(args);
            };
        },
    });
    const worktreePath = path.join(root, `fallback-ahead-${serial}`);
    await assert.rejects(
        addWorktreeWithoutTracking(fooled, worktreePath, BRANCH, { startPoint: `origin/${BRANCH}`, resetBranch: true, refuseLocalOnlyCommits: true }),
        refusesNamingBranch,
    );
    assert.ok(missed, 'only the fallback on Git\'s refusal saw the branch');
    assert.equal(await branchTip(), unpushed);
    assert.equal(await supersededBackups(), '');
    assert.equal(await fs.pathExists(worktreePath), false);
});
