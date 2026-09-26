import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHooklessGit as realGit } from '../packages/core/src/git/hooklessGit.js';
import { up, down } from '../packages/core/src/db/migrations/20260914000000_add_pr_continuations.js';

import { up as checkpointUp, down as checkpointDown } from '../packages/core/src/db/migrations/20260914010000_add_pr_publication_checkpoint.js';

import { up as completionUp, down as completionDown } from '../packages/core/src/db/migrations/20260914020000_add_pr_publication_completion.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
await checkpointUp(database);
await completionUp(database);
const root = await mkdtemp(path.join(tmpdir(), 'pr-continuation-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test Worker', '-c', 'user.email=worker@example.test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// All repositories are disposable fixtures; no workspace Git metadata is modified.
git(root, 'init', '--bare', 'upstream.git');
git(root, 'clone', path.join(root, 'upstream.git'), 'seed');
const seed = path.join(root, 'seed');
await writeFile(path.join(seed, 'base.txt'), 'base\n');
git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Base');
const baseSha = git(seed, 'rev-parse', 'HEAD');
git(seed, 'branch', '-M', 'release'); git(seed, 'push', 'origin', 'release');
git(root, 'clone', '--bare', path.join(root, 'upstream.git'), 'fork.git');
git(seed, 'checkout', '-b', 'contribution');
await writeFile(path.join(seed, 'contributor.txt'), 'contribution\n');
git(seed, 'add', '.'); git(seed, 'commit', '--author=Original Contributor <contributor@example.test>', '-m', 'Contributor change');
const sourceSha = git(seed, 'rev-parse', 'HEAD');
git(seed, 'push', path.join(root, 'fork.git'), 'contribution');
// GitHub's PR refs make the contribution commit available in the upstream repository.
git(seed, 'push', 'origin', 'HEAD:refs/pull/42/head');

let probeError: Error | undefined;
let finalPushError: Error | undefined;
let continuationPushError: Error | undefined;
let authError: Error | undefined;
let failPRCreate: boolean | 'after-publish' = false;
let createAttempts = 0;
let calls: Array<{ operation: string; args: unknown }> = [];
let cloneIndex = 0;
const token = 'ghs_worker_installation_token';
const repoPath = (owner: string) => path.join(root, owner === 'upstream' ? 'upstream.git' : 'fork.git');

await mock.module('@propr/core', { namedExports: {
    db: database,
    logger: { warn: () => undefined },
    getAuthenticatedOctokit: async () => octokit,
    getRepoUrl: ({ repoOwner }: { repoOwner: string }) => repoPath(repoOwner),
    createHooklessGit: (worktree: string) => {
        const actual = realGit(worktree);
        return {
            raw: async (args: string[]) => {
                calls.push({ operation: 'git', args });
                if (args.includes('--dry-run') && probeError) throw probeError;
                if (args[0] === 'push' && args.includes('HEAD:refs/heads/propr/continuation-pr-42') && continuationPushError) throw continuationPushError;
                return actual.raw(args);
            },
            revparse: (args: string[]) => actual.revparse(args),
        };
    },
    ensureRepoCloned: async ({ owner, authToken }: { owner: string; authToken: string }) => {
        assert.equal(authToken, token);
        return repoPath(owner);
    },
    createWorktreeFromExistingBranch: async (repo: string, branchName: string) => {
        const worktreePath = path.join(root, `work-${++cloneIndex}`);
        git(root, 'clone', '--branch', branchName, repo, worktreePath);
        git(worktreePath, 'config', 'user.name', 'Test Worker');
        git(worktreePath, 'config', 'user.email', 'worker@example.test');
        calls.push({ operation: 'worktree', args: { repo, branchName, worktreePath } });
        return { worktreePath, branchName };
    },
    cleanupWorktree: async (...args: unknown[]) => { calls.push({ operation: 'cleanup', args }); },
    pushBranch: async (worktree: string, branchName: string, options: { repoUrl: string; authToken: string; rebaseOnNonFastForward?: boolean }) => {
        assert.equal(options.authToken, token);
        calls.push({ operation: 'forkPush', args: { worktree, branchName, options } });
        if (finalPushError) throw finalPushError;
        git(worktree, 'push', options.repoUrl, `HEAD:refs/heads/${branchName}`);
        return { rebased: false, commitHash: git(worktree, 'rev-parse', 'HEAD') };
    },
} });

const { PullRequestPublication } = await import('../src/jobs/prPublication.js');
const { ensurePRContinuation, announceContinuation, findPRContinuation, continuationStatus, reserveContinuation, continuationBody, MAX_PULL_REQUEST_BODY_LENGTH } = await import('../src/jobs/prContinuation.js');
await mock.module('../src/jobs/ultrafixOrchestrationService.js', { namedExports: {
    stopLoop: async (...args: unknown[]) => { calls.push({ operation: 'stopLoop', args }); },
} });
const { stopOriginalPRReviewCycle } = await import('../src/jobs/prContinuationReview.js');
const { isPublicationPermissionDenied } = await import('../src/jobs/prPublicationGit.js');
const ref = { repoOwner: 'upstream', repoName: 'project', pullRequestNumber: 42 };
const source = {
    head: { ref: 'contribution', sha: sourceSha, repo: { owner: { login: 'contributor' }, name: 'project' } },
    base: { ref: 'release' }, title: 'Contribution', body: 'Original objective', user: { login: 'contributor' },
};
type FakePR = { number: number; state: string; html_url: string; body: string; base: { ref: string }; head: { ref: string; repo: { full_name: string } } };
let prs: FakePR[] = [];
let comments: Array<{ id: number; body: string; user: { type: string } }> = [];
let loseCreateResponse = false;
let failComment = false;
const octokit = {
    auth: async (options: unknown) => {
        calls.push({ operation: 'auth', args: options });
        assert.deepEqual(options, { type: 'installation' });
        if (authError) throw authError;
        return { token };
    },
    paginate: async (endpoint: string) => endpoint.endsWith('/pulls') ? [...prs] : [...comments],
    request: async (endpoint: string, options: Record<string, any>) => {
        calls.push({ operation: endpoint, args: options });
        if (endpoint === 'POST /repos/{owner}/{repo}/git/refs') {
            try { git(repoPath('upstream'), 'show-ref', '--verify', options.ref); }
            catch { git(repoPath('upstream'), 'update-ref', options.ref, options.sha); return { data: {} }; }
            throw Object.assign(new Error('Reference already exists'), { status: 422 });
        }
        if (endpoint.includes('/compare/')) {
            const tip = git(repoPath('upstream'), 'rev-parse', 'refs/heads/propr/continuation-pr-42');
            return { data: { status: tip === sourceSha ? 'identical' : 'ahead' } };
        }
        if (endpoint === 'POST /repos/{owner}/{repo}/pulls') {
            createAttempts += 1;
            if (failPRCreate === true || (failPRCreate === 'after-publish' && createAttempts > 1)) throw new Error('PR creation network error');
            if (prs.length) throw Object.assign(new Error('PR already exists'), { status: 422 });
            // GitHub's own validation: a head with nothing ahead of the base, and the body size limit.
            if (isUpstreamAncestor(`refs/heads/${options.head}`, `refs/heads/${options.base}`)) {
                throw Object.assign(new Error('Validation Failed'), { status: 422, response: { data: { errors: [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${options.base} and ${options.head}` }] } } });
            }
            if (options.body.length > 65536) throw Object.assign(new Error('Validation Failed: body is too long (maximum is 65536 characters)'), { status: 422 });
            const pr = { number: 100, state: 'open', html_url: 'https://github.com/upstream/project/pull/100', body: options.body, base: { ref: options.base }, head: { ref: options.head, repo: { full_name: 'upstream/project' } } };
            prs.push(pr);
            if (loseCreateResponse) { loseCreateResponse = false; throw new Error('ECONNRESET after create'); }
            return { data: pr };
        }
        if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: prs[0] };
        if (endpoint.endsWith('/comments') && endpoint.startsWith('POST')) {
            assert.equal(options.issue_number, 42);
            if (failComment) throw new Error('Comment network error');
            const comment = { id: comments.length + 1, body: options.body, user: { type: 'Bot' } };
            comments.push(comment);
            return { data: comment };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
};
const isUpstreamAncestor = (ancestor: string, descendant: string) => {
    try { git(repoPath('upstream'), 'merge-base', '--is-ancestor', ancestor, descendant); return true; } catch { return false; }
};
const session = (contribution = source) => new PullRequestPublication(octokit as never, ref, contribution);
const denial = () => new Error('remote: Write access to repository not granted. fatal: HTTP 403');
const bundlePrerequisites = (bundle: string) => Buffer.from(bundle, 'base64').toString('latin1').split('\n\n', 1)[0]
    .split('\n').filter(line => line.startsWith('-')).map(line => line.slice(1, 41));

beforeEach(async () => {
    await database('pr_continuations').delete();
    git(repoPath('upstream'), 'update-ref', '-d', 'refs/heads/propr/continuation-pr-42');
    git(repoPath('upstream'), 'update-ref', 'refs/heads/release', baseSha);
    git(repoPath('contributor'), 'update-ref', 'refs/heads/contribution', sourceSha);
    calls = []; prs = []; comments = []; probeError = undefined; finalPushError = undefined;
    loseCreateResponse = false; failComment = false; failPRCreate = false; createAttempts = 0; continuationPushError = undefined; authError = undefined;
});
after(async () => { await completionDown(database); await checkpointDown(database); await down(database); await database.destroy(); await rm(root, { recursive: true, force: true }); });

async function implement(worktree: string) {
    await writeFile(path.join(worktree, 'implementation.txt'), 'implemented once\n');
    git(worktree, 'add', '.'); git(worktree, 'commit', '-m', 'Implementation');
    return git(worktree, 'rev-parse', 'HEAD');
}

test('writable forks use installation auth for preflight and publish on the original branch', async () => {
    const publication = session();
    const prepared = await publication.prepare('writable');
    const head = await implement(prepared.worktreeInfo.worktreePath);
    await publication.push(prepared.worktreeInfo.worktreePath);
    assert.equal(git(repoPath('contributor'), 'rev-parse', 'contribution'), head);
    assert.equal(await findPRContinuation(ref), undefined);
    assert.equal(prs.length, 0);
    assert.equal(publication.status, '');
    assert.ok(calls.some(c => c.operation === 'git' && (c.args as string[]).includes('--dry-run')));
    assert.equal(calls.filter(c => c.operation === 'auth').length, 2);
});

test('merge publication can disable non-fast-forward rebasing without disabling continuation adoption', async () => {
    const publication = session();
    const prepared = await publication.prepare('merge-no-rebase');
    await implement(prepared.worktreeInfo.worktreePath);
    await publication.push(prepared.worktreeInfo.worktreePath, undefined, { rebaseOnNonFastForward: false });
    const forkPush = calls.find(call => call.operation === 'forkPush');
    assert.equal((forkPush?.args as { options: { rebaseOnNonFastForward?: boolean } }).options.rebaseOnNonFastForward, false);
});

test('denial before execution starts upstream at the exact source SHA, preserving attribution and base', async () => {
    probeError = denial();
    const publication = session();
    const { worktreeInfo } = await publication.prepare('denied');
    assert.equal(publication.target.repoOwner, 'upstream');
    assert.equal(git(worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), sourceSha);
    assert.equal(git(worktreeInfo.worktreePath, 'show', '-s', '--format=%an <%ae>', sourceSha), 'Original Contributor <contributor@example.test>');
    assert.equal(prs[0].base.ref, 'release');
    assert.ok(prs[0].body.includes(sourceSha));
    assert.match(prs[0].body, /upstream\/project\/pull\/42/);
    assert.match(comments[0].body, /pull\/100/);
    assert.match(comments[0].body, /remain open/);
    assert.ok(!calls.some(c => c.operation.startsWith('PATCH')));
});

test('final push denial publishes the existing implementation commit without rerunning execution', async () => {
    const publication = session();
    const { worktreeInfo } = await publication.prepare('revoked');
    const produced = await implement(worktreeInfo.worktreePath);
    finalPushError = denial();
    const pushed = await publication.push(worktreeInfo.worktreePath);
    assert.equal(pushed.commitHash, produced);
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced);
    assert.equal(git(repoPath('upstream'), 'rev-parse', `${produced}^`), sourceSha);
    assert.equal(calls.filter(c => c.operation === 'worktree').length, 1);
    const createRef = calls.find(c => c.operation.endsWith('/git/refs'))!;
    assert.equal((createRef.args as any).sha, sourceSha);
});

test('workflow-permission denial on the final fork push publishes through the continuation', async () => {
    const publication = session();
    const { worktreeInfo } = await publication.prepare('workflow-permission-revoked');
    const produced = await implement(worktreeInfo.worktreePath);
    finalPushError = new Error("remote: refusing to allow a GitHub App to create or update workflow `.github/workflows/pr-build-check.yml` without `workflows` permission");

    const pushed = await publication.push(worktreeInfo.worktreePath);

    assert.equal(pushed.commitHash, produced);
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced);
    assert.equal(prs.length, 1);
    assert.match(publication.status, /pull\/100/);
});

for (const message of ['Could not resolve host github.com', 'Connection timed out', 'non-fast-forward', 'Authentication failed', 'HTTP 403 rate limit', 'remote: GH013: Repository rule violations', 'Repository not found']) {
    test(`transient/other failure does not adopt: ${message}`, async () => {
        probeError = new Error(message);
        await assert.rejects(session().prepare('transient'), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.equal(prs.length, 0);
        assert.equal(await findPRContinuation(ref), undefined);
        probeError = undefined;
        const publication = session();
        const prepared = await publication.prepare('final-transient');
        finalPushError = new Error(message);
        await assert.rejects(publication.push(prepared.worktreeInfo.worktreePath));
        assert.equal(await findPRContinuation(ref), undefined);
    });
}

test('duplicate/concurrent requests and a lost create response reuse one durable PR', async () => {
    loseCreateResponse = true;
    const records = await Promise.all(Array.from({ length: 5 }, () => ensurePRContinuation(octokit as never, ref, source)));
    assert.deepEqual(records.map(r => r.continuation_pr), [100, 100, 100, 100, 100]);
    assert.equal(prs.length, 1);
    assert.equal((await database('pr_continuations')).length, 1);
    const retry = await ensurePRContinuation(octokit as never, ref, { ...source, head: { ...source.head, sha: 'f'.repeat(40) } });
    assert.equal(retry.source_sha, sourceSha);
    assert.equal(retry.continuation_pr, 100);
});

test('a failed announcement is repaired on retry without duplicating the continuation', async () => {
    failComment = true;
    const record = await ensurePRContinuation(octokit as never, ref, source);
    await assert.rejects(announceContinuation(octokit as never, record), /Comment network error/);
    assert.equal((await findPRContinuation(ref))?.continuation_pr, 100);
    failComment = false;
    await announceContinuation(octokit as never, record);
    await announceContinuation(octokit as never, record);
    assert.equal(prs.length, 1);
    assert.equal(comments.length, 1);
});

test('subsequent original-PR follow-ups use the existing continuation even if fork access returns', async () => {
    probeError = denial();
    const first = session();
    const initial = await first.prepare('first');
    const produced = await implement(initial.worktreeInfo.worktreePath);
    await first.push(initial.worktreeInfo.worktreePath);
    probeError = undefined;
    const later = session();
    const followup = await later.prepare('later');
    assert.equal(git(followup.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), produced);
    assert.equal(later.target.branchName, 'propr/continuation-pr-42');
    assert.equal(prs.length, 1);
    assert.match(later.status, /pull\/100/);
    assert.match(later.status, /pull\/42/);
    const reverse = await findPRContinuation({ ...ref, pullRequestNumber: 100 });
    assert.equal(reverse?.source_pr, 42);
    assert.equal(continuationStatus(reverse), later.status);
});

test('closed continuations remain mapped and are never replaced', async () => {
    await ensurePRContinuation(octokit as never, ref, source);
    prs[0].state = 'closed';
    await assert.rejects(session().prepare('closed'), /Continuation PR is closed/);
    assert.equal(prs.length, 1);
});

test('permission classification is narrow and rejects generic HTTP status failures', () => {
    for (const message of [
        'Permission to contributor/project.git denied to propr[bot].',
        'Resource not accessible by integration',
        "remote: refusing to allow a GitHub App to create or update workflow `.github/workflows/pr-build-check.yml` without `workflows` permission",
    ]) {
        assert.equal(isPublicationPermissionDenied(new Error(message)), true);
    }
    assert.equal(isPublicationPermissionDenied(new Error('The requested URL returned error: 403')), false);
});

test('an existing continuation remains usable after the original fork is deleted', async () => {
    await ensurePRContinuation(octokit as never, ref, source);
    const publication = session({ ...source, head: { ...source.head, repo: null } } as never);
    const prepared = await publication.prepare('deleted-source');
    assert.equal(git(prepared.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), sourceSha);
    assert.equal(publication.target.repoOwner, 'upstream');
});

test('concurrent continuation pushes merge while preserving both implementation commit identities', async () => {
    probeError = denial();
    const first = session();
    const initial = await first.prepare('concurrent-first');
    const second = session();
    const other = await second.prepare('concurrent-second');
    const produced = await implement(initial.worktreeInfo.worktreePath);
    await writeFile(path.join(other.worktreeInfo.worktreePath, 'other.txt'), 'concurrent implementation\n');
    git(other.worktreeInfo.worktreePath, 'add', '.');
    git(other.worktreeInfo.worktreePath, 'commit', '-m', 'Other implementation');
    const concurrent = git(other.worktreeInfo.worktreePath, 'rev-parse', 'HEAD');
    await second.push(other.worktreeInfo.worktreePath);
    const result = await first.push(initial.worktreeInfo.worktreePath);
    const upstream = repoPath('upstream');
    git(upstream, 'merge-base', '--is-ancestor', produced, result.commitHash!);
    git(upstream, 'merge-base', '--is-ancestor', concurrent, result.commitHash!);
    git(upstream, 'merge-base', '--is-ancestor', sourceSha, result.commitHash!);
    assert.equal(prs.length, 1);
});

test('permission failures never expose the installation token', async () => {
    probeError = new Error(`remote: Write access to repository not granted: https://x-access-token:${token}@github.com/contributor/project`);
    // Make adoption fail too, to inspect the preflight error separately.
    const { checkPullRequestHeadWritable } = await import('../src/jobs/prPublicationGit.js');
    await assert.rejects(checkPullRequestHeadWritable(seed, { repoOwner: 'contributor', repoName: 'project', branchName: 'contribution', isFork: true }, token), error => {
        assert.equal((error as Error).message.includes(token), false);
        assert.equal(isPublicationPermissionDenied(error), true);
        return true;
    });
});

test('preflight adoption uses the captured contribution SHA even if the fork advances during preparation', async () => {
    git(seed, 'commit', '--allow-empty', '-m', 'Later contributor commit');
    const advanced = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'push', repoPath('contributor'), 'HEAD:refs/heads/contribution');
    probeError = denial();
    const publication = session();
    const prepared = await publication.prepare('moving-fork');
    assert.equal(git(prepared.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), sourceSha);
    assert.equal(git(repoPath('contributor'), 'rev-parse', 'contribution'), advanced);
    assert.equal(publication.continuation?.source_sha, sourceSha);
});

test('preparation rejects a rewritten head even when the captured commit remains in the clone', async () => {
    git(repoPath('contributor'), 'update-ref', 'refs/heads/contribution', `${sourceSha}^`);
    // Local cloning retains the old object, so existence alone cannot validate the baseline.
    await assert.rejects(session().prepare('rewritten-fork'), /retry preparation before implementation/);
    const worktree = calls.find(c => c.operation === 'worktree')!.args as { worktreePath: string };
    git(worktree.worktreePath, 'cat-file', '-e', sourceSha);
    assert.ok(calls.some(c => c.operation === 'cleanup'));
    assert.ok(!calls.some(c => c.operation === 'git' && (c.args as string[]).includes('--dry-run')));
    assert.equal(await findPRContinuation(ref), undefined);
});

test('same-repository permission failures never create a fork continuation', async () => {
    const publication = session({ ...source, head: { ref: 'release', sha: sourceSha, repo: { owner: { login: 'upstream' }, name: 'project' } } });
    const prepared = await publication.prepare('same-repository');
    finalPushError = denial();
    await assert.rejects(publication.push(prepared.worktreeInfo.worktreePath), /Write access/);
    assert.equal(await findPRContinuation(ref), undefined);
    assert.equal(prs.length, 0);
});


test('announcement failure after implementation cannot prevent publication and retries independently', async () => {
    const publication = session();
    const { worktreeInfo } = await publication.prepare('implementation-announcement');
    const produced = await implement(worktreeInfo.worktreePath);
    finalPushError = denial();
    failComment = true;
    const result = await publication.push(worktreeInfo.worktreePath);
    assert.equal(result.commitHash, produced);
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced);
    assert.equal((await findPRContinuation(ref))?.comment_id, null);
    await rm(worktreeInfo.worktreePath, { recursive: true, force: true });
    failComment = false;
    const later = await session().prepare('retry-announcement');
    assert.equal(git(later.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), produced);
    assert.equal(comments.length, 1);
    assert.equal(prs.length, 1);
});

for (const failure of ['PR creation', 'continuation push']) {
    test(`checkpoint restores completed work after ${failure} fails and the worktree is deleted`, async () => {
        const publication = session();
        const { worktreeInfo } = await publication.prepare('checkpoint');
        const produced = await implement(worktreeInfo.worktreePath);
        finalPushError = denial();
        if (failure === 'PR creation') failPRCreate = true;
        else continuationPushError = new Error('Connection timed out');
        await assert.rejects(publication.push(worktreeInfo.worktreePath));
        const bundle = (await findPRContinuation(ref))?.publication_bundle;
        assert.ok(bundle);
        // Upstream only holds the captured SHA (through the PR ref); the fork tip is no prerequisite.
        assert.deepEqual(bundlePrerequisites(bundle), [sourceSha]);
        await rm(worktreeInfo.worktreePath, { recursive: true, force: true });
        failPRCreate = false;
        continuationPushError = undefined;
        const later = await session().prepare('recover-checkpoint');
        assert.equal(git(later.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), produced);
        assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced);
        assert.equal((await findPRContinuation(ref))?.publication_bundle, null);
        assert.equal(prs.length, 1);
    });
}

for (const failure of ['PR creation', 'continuation push']) {
    test(`a rejected publish guard after ${failure} failure keeps the checkpoint unpublished and discards the worktree`, async () => {
        const publication = session();
        const { worktreeInfo } = await publication.prepare('guarded-checkpoint');
        const produced = await implement(worktreeInfo.worktreePath);
        finalPushError = denial();
        if (failure === 'PR creation') failPRCreate = true;
        else continuationPushError = new Error('Connection timed out');
        await assert.rejects(publication.push(worktreeInfo.worktreePath));
        await rm(worktreeInfo.worktreePath, { recursive: true, force: true });
        failPRCreate = false;
        continuationPushError = undefined;
        const cancelled = new Error('originating task cancelled');
        let guardedAfterWorktree = false;
        const beforePublish = async () => {
            // The guard runs after the asynchronous worktree preparation, before any push.
            guardedAfterWorktree = calls.some(call => call.operation === 'worktree');
            throw cancelled;
        };
        calls = [];
        await assert.rejects(session().prepare('cancelled-recovery', { beforePublish }), error => error === cancelled);
        assert.ok(guardedAfterWorktree);
        assert.equal(calls.filter(call => call.operation === 'cleanup').length, 1);
        assert.ok(!calls.some(call => call.operation === 'git' && (call.args as string[])[0] === 'push'));
        assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), sourceSha);
        assert.ok((await findPRContinuation(ref))?.publication_bundle);
        // The continuation PR is created before the push; it holds only the contribution until recovery.
        assert.equal(prs.length, 1);
        // The retained checkpoint is still recoverable by a later request.
        const later = await session().prepare('recover-after-guard');
        assert.equal(git(later.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), produced);
        assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced);
        assert.equal((await findPRContinuation(ref))?.publication_bundle, null);
    });
}

test('final push denial publishes the saved implementation before creating a PR the base would reject as empty', async () => {
    const publication = session();
    const { worktreeInfo } = await publication.prepare('merged-base');
    const produced = await implement(worktreeInfo.worktreePath);
    // The contribution is merged into the base while the agent runs.
    git(repoPath('upstream'), 'update-ref', 'refs/heads/release', sourceSha);
    finalPushError = denial();
    const pushed = await publication.push(worktreeInfo.worktreePath);
    assert.equal(pushed.commitHash, produced);
    assert.equal(prs.length, 1);
    assert.equal(createAttempts, 2);
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced);
    assert.equal((calls.find(c => c.operation.endsWith('/git/refs'))!.args as any).sha, sourceSha);
    const record = (await findPRContinuation(ref))!;
    assert.equal(record.continuation_pr, 100);
    assert.equal(record.publication_bundle, null);
});

test('recovery publishes the checkpoint before creating a PR the base would reject as empty', async () => {
    const publication = session();
    const { worktreeInfo } = await publication.prepare('merged-base-recovery');
    const produced = await implement(worktreeInfo.worktreePath);
    finalPushError = denial();
    failPRCreate = true;
    await assert.rejects(publication.push(worktreeInfo.worktreePath), /network error/);
    await rm(worktreeInfo.worktreePath, { recursive: true, force: true });
    git(repoPath('upstream'), 'update-ref', 'refs/heads/release', sourceSha);
    failPRCreate = false; calls = [];
    const later = await session().prepare('recover-merged-base');
    assert.equal(git(later.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), produced);
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced);
    assert.equal(prs.length, 1);
    assert.equal(calls.filter(c => c.operation === 'worktree').length, 1);
    assert.ok(!calls.some(c => c.operation === 'cleanup'));
    const record = (await findPRContinuation(ref))!;
    assert.equal(record.continuation_pr, 100);
    assert.equal(record.publication_bundle, null);
});

test('checkpoint is retained when PR creation still fails after publishing the saved implementation', async () => {
    const publication = session();
    const { worktreeInfo } = await publication.prepare('merged-base-retained');
    const produced = await implement(worktreeInfo.worktreePath);
    git(repoPath('upstream'), 'update-ref', 'refs/heads/release', sourceSha);
    finalPushError = denial();
    failPRCreate = 'after-publish';
    await assert.rejects(publication.push(worktreeInfo.worktreePath), /network error/);
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced);
    assert.equal(prs.length, 0);
    assert.ok((await findPRContinuation(ref))?.publication_bundle);
    await rm(worktreeInfo.worktreePath, { recursive: true, force: true });
    failPRCreate = false;
    const later = await session().prepare('recover-merged-base-retained');
    assert.equal(git(later.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), produced);
    assert.equal(prs.length, 1);
    assert.equal((await findPRContinuation(ref))?.publication_bundle, null);
});

test('an oversized original body is bounded in the continuation PR while the stored objective stays complete', async () => {
    const body = 'objective '.repeat(7000);
    const record = await ensurePRContinuation(octokit as never, ref, { ...source, body });
    assert.equal(prs.length, 1);
    assert.ok(prs[0].body.length <= MAX_PULL_REQUEST_BODY_LENGTH);
    assert.ok(prs[0].body.startsWith(`<!-- propr-continuation:42:${sourceSha} -->`));
    assert.match(prs[0].body, /Read the complete text on https:\/\/github\.com\/upstream\/project\/pull\/42\._$/);
    assert.equal(record.source_body, body);
    assert.equal((await findPRContinuation({ ...ref, pullRequestNumber: 100 }))?.source_body, body);
    const short = continuationBody({ ...record, source_body: 'Original objective' }, '<!-- marker -->');
    assert.ok(short.endsWith('Original objective:\nOriginal objective'));
    const emoji = continuationBody({ ...record, source_body: '😀'.repeat(40000) }, '<!-- marker -->');
    assert.ok(emoji.length <= MAX_PULL_REQUEST_BODY_LENGTH);
    assert.equal(Buffer.from(emoji, 'utf8').toString('utf8'), emoji);
});

test('failed recovery keeps its checkpoint for another worker', async () => {
    probeError = denial();
    const publication = session();
    const { worktreeInfo } = await publication.prepare('adopt-first');
    const produced = await implement(worktreeInfo.worktreePath);
    continuationPushError = new Error('Connection timed out');
    await assert.rejects(publication.push(worktreeInfo.worktreePath));
    await rm(worktreeInfo.worktreePath, { recursive: true, force: true });
    await assert.rejects(session().prepare('recovery-fails'), /Connection timed out/);
    assert.ok((await findPRContinuation(ref))?.publication_bundle);
    continuationPushError = undefined;
    const recovered = await session().prepare('recovery-succeeds');
    assert.equal(git(recovered.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), produced);
    assert.equal((await findPRContinuation(ref))?.publication_bundle, null);
});

for (const commandMode of ['review', 'fix']) {
    test(`${commandMode} on original stops the loop and directs users to the continuation`, async () => {
        const continuation = await ensurePRContinuation(octokit as never, ref, source);
        const options = { ref, continuation, commandMode, ultrafix: true, redis: {} as never, octokit: octokit as never };
        const body = await stopOriginalPRReviewCycle(options);
        assert.match(body!, /pull\/100/);
        assert.match(body!, /original discussion remains available/);
        assert.equal(calls.filter(c => c.operation === 'stopLoop').length, 1);
        const before = calls.length;
        assert.equal(await stopOriginalPRReviewCycle({ ...options, ref: { ...ref, pullRequestNumber: 100 } }), undefined);
        assert.equal(calls.length, before);
        assert.equal(await stopOriginalPRReviewCycle({ ...options, commandMode: 'default', ultrafix: false }), undefined);
        assert.equal(calls.length, before);
    });
}


test('checkpoint recovery merges an advanced continuation without losing either commit', async () => {
    const publication = session();
    const { worktreeInfo } = await publication.prepare('checkpoint-concurrent');
    const produced = await implement(worktreeInfo.worktreePath);
    finalPushError = denial();
    continuationPushError = new Error('Connection timed out');
    await assert.rejects(publication.push(worktreeInfo.worktreePath));
    await rm(worktreeInfo.worktreePath, { recursive: true, force: true });
    const concurrentPath = path.join(root, `external-${++cloneIndex}`);
    git(root, 'clone', '--branch', 'propr/continuation-pr-42', repoPath('upstream'), concurrentPath);
    await writeFile(path.join(concurrentPath, 'external.txt'), 'other work\n');
    git(concurrentPath, 'add', '.');
    git(concurrentPath, 'commit', '-m', 'Concurrent work');
    const concurrent = git(concurrentPath, 'rev-parse', 'HEAD');
    git(concurrentPath, 'push', 'origin', 'HEAD');
    continuationPushError = undefined;
    await session().prepare('merge-checkpoint');
    const tip = git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42');
    git(repoPath('upstream'), 'merge-base', '--is-ancestor', produced, tip);
    git(repoPath('upstream'), 'merge-base', '--is-ancestor', concurrent, tip);
    assert.equal((await findPRContinuation(ref))?.publication_bundle, null);
});

test('follow-up checkpoints on an existing continuation exclude its published history', async () => {
    probeError = denial();
    const first = session();
    const initial = await first.prepare('incremental-first');
    const produced = await implement(initial.worktreeInfo.worktreePath);
    await first.push(initial.worktreeInfo.worktreePath);
    probeError = undefined;
    // A maintainer updates the continuation from its base, bringing in a large blob.
    const maintainer = path.join(root, `maintainer-${++cloneIndex}`);
    git(root, 'clone', '--branch', 'release', repoPath('upstream'), maintainer);
    await writeFile(path.join(maintainer, 'base-update.bin'), randomBytes(256 * 1024));
    git(maintainer, 'add', '.'); git(maintainer, 'commit', '-m', 'Base update');
    git(maintainer, 'push', 'origin', 'HEAD:refs/heads/release');
    git(maintainer, 'checkout', '-b', 'continuation', 'origin/propr/continuation-pr-42');
    git(maintainer, 'merge', '--no-edit', 'release');
    const updated = git(maintainer, 'rev-parse', 'HEAD');
    git(maintainer, 'push', 'origin', 'HEAD:refs/heads/propr/continuation-pr-42');
    const later = session();
    const followup = await later.prepare('incremental-followup');
    assert.equal(git(followup.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), updated);
    await writeFile(path.join(followup.worktreeInfo.worktreePath, 'second.txt'), 'second implementation\n');
    git(followup.worktreeInfo.worktreePath, 'add', '.'); git(followup.worktreeInfo.worktreePath, 'commit', '-m', 'Second implementation');
    const second = git(followup.worktreeInfo.worktreePath, 'rev-parse', 'HEAD');
    continuationPushError = new Error('Connection timed out');
    await assert.rejects(later.push(followup.worktreeInfo.worktreePath), /Connection timed out/);
    const bundle = (await findPRContinuation(ref))!.publication_bundle!;
    assert.deepEqual(bundlePrerequisites(bundle), [updated]);
    assert.match(Buffer.from(bundle, 'base64').toString('latin1'), new RegExp(`^${second} HEAD$`, 'm'));
    // Neither the earlier implementation nor the base update is stored again.
    assert.ok(Buffer.from(bundle, 'base64').length < 64 * 1024);
    await rm(followup.worktreeInfo.worktreePath, { recursive: true, force: true });
    continuationPushError = undefined;
    const recovered = await session().prepare('incremental-recovery');
    assert.equal(git(recovered.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), second);
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), second);
    git(repoPath('upstream'), 'merge-base', '--is-ancestor', produced, second);
    assert.equal((await findPRContinuation(ref))?.publication_bundle, null);
});

test('a rejected credential refresh on an adopted continuation keeps a recoverable checkpoint', async () => {
    probeError = denial();
    const first = session();
    const initial = await first.prepare('auth-rejected');
    probeError = undefined;
    const produced = await implement(initial.worktreeInfo.worktreePath);
    const completion = { commitResult: { commitHash: produced }, taskId: 'task-1' };
    authError = new Error('Installation token refresh rejected');
    calls = [];
    await assert.rejects(first.push(initial.worktreeInfo.worktreePath, completion as never), /token refresh rejected/);
    // The bundle was written before the credential request, so nothing was pushed with it.
    assert.ok(calls.some(c => c.operation === 'git' && (c.args as string[])[0] === 'bundle'));
    assert.ok(!calls.some(c => c.operation === 'git' && (c.args as string[])[0] === 'push'));
    const record = await findPRContinuation(ref);
    assert.ok(record?.publication_bundle);
    assert.deepEqual(bundlePrerequisites(record.publication_bundle), [sourceSha]);
    assert.equal(JSON.parse(record.publication_completion!).taskId, 'task-1');
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), sourceSha);
    await rm(initial.worktreeInfo.worktreePath, { recursive: true, force: true });
    authError = undefined;
    const later = session();
    const recovered = await later.prepare('auth-recovery');
    // The exact committed HEAD is restored and published; no implementation reruns.
    assert.equal(git(recovered.worktreeInfo.worktreePath, 'rev-parse', 'HEAD'), produced);
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced);
    assert.equal((await findPRContinuation(ref))?.publication_bundle, null);
    assert.equal(later.pendingCompletion?.commitResult?.commitHash, produced);
    assert.equal(prs.length, 1);
});

test('a follow-up whose checkpoint was already published stores no bundle on retry', async () => {
    probeError = denial();
    const first = session();
    const initial = await first.prepare('published-first');
    const produced = await implement(initial.worktreeInfo.worktreePath);
    continuationPushError = new Error('Connection timed out');
    await assert.rejects(first.push(initial.worktreeInfo.worktreePath), /Connection timed out/);
    await rm(initial.worktreeInfo.worktreePath, { recursive: true, force: true });
    continuationPushError = undefined;
    const later = session();
    const recovered = await later.prepare('published-recovery');
    assert.equal(git(repoPath('upstream'), 'rev-parse', 'propr/continuation-pr-42'), produced);
    // HEAD is exactly the published tip: an empty checkpoint is a null bundle, not a Git error.
    calls = [];
    const result = await later.push(recovered.worktreeInfo.worktreePath);
    assert.equal(result.commitHash, produced);
    assert.equal((await findPRContinuation(ref))?.publication_bundle, null);
    assert.ok(!calls.some(c => c.operation === 'git' && (c.args as string[])[0] === 'bundle'));
});

for (const identity of ['both', 'branch only', 'marker only', 'wrong repository', 'wrong base']) {
    test(`reservation discovery requires both identities and the Git target: ${identity}`, async () => {
        const reservation = await reserveContinuation(ref, source);
        prs.push({
            number: 100, state: 'open', html_url: 'https://github.com/upstream/project/pull/100',
            body: identity === 'branch only' ? '' : `<!-- propr-continuation:42:${sourceSha} -->`,
            base: { ref: identity === 'wrong base' ? 'main' : reservation.base_branch },
            head: {
                ref: identity === 'marker only' ? 'unrelated' : reservation.branch_name,
                repo: { full_name: identity === 'wrong repository' ? 'contributor/project' : reservation.repository },
            },
        });
        const discovered = await findPRContinuation({ ...ref, pullRequestNumber: 100 }, octokit as never);
        assert.equal(discovered?.continuation_pr, identity === 'both' ? 100 : undefined);
        assert.equal((await findPRContinuation(ref))!.continuation_pr, identity === 'both' ? 100 : null);
    });
}
