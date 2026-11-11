import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendOverlapNote, buildPullRequestOverlapNote } from '../src/jobs/prFileOverlapNote.js';

const { db } = await import('@propr/core');
after(() => db.destroy());

const now = Date.now();
const fileChanges = (...paths: string[]) => JSON.stringify({ files: paths.map(path => ({ path })) });

function fakeRedis(status = 'ready') {
    const active = new Map([['task-new', now], ['task-other', now], ['task-stale', now - 10 * 60_000]]);
    const strings = new Map([
        ['task:file-changes:task-other', fileChanges('src/shared.ts', 'src/elsewhere.ts')],
        ['task:file-changes:task-stale', fileChanges('src/shared.ts')],
    ]);
    return {
        status,
        zremrangebyscore: async (_key: string, _min: string, max: number) => { for (const [id, score] of active) if (score <= max) active.delete(id); return 0; },
        zrange: async () => [...active.keys()],
        mget: async (...keys: string[]) => keys.map(key => strings.get(key) ?? null),
    };
}

function fakeOctokit() {
    const requests: string[] = [];
    return {
        requests,
        request: async (route: string, params: Record<string, unknown>) => {
            requests.push(`${route} ${params.pull_number ?? ''}`.trim());
            if (route === 'GET /repos/{owner}/{repo}/pulls') {
                return { data: [
                    { number: 7, head: { ref: 'propr/other' }, labels: [{ name: 'AI-PR' }] },
                    { number: 8, head: { ref: 'human/branch' }, labels: [] },
                    { number: 9, head: { ref: 'propr/new' }, labels: [{ name: 'AI-PR' }] },
                ] };
            }
            return { data: [{ filename: 'src/shared.ts' }, { filename: 'README.md' }] };
        },
    };
}

test('a new PR notes active tasks and open ProPR PRs changing the same files', async () => {
    const octokit = fakeOctokit();
    const note = await buildPullRequestOverlapNote({
        octokit, redis: fakeRedis() as never, repoOwner: 'acme', repoName: 'widget', taskId: 'task-new',
        branchName: 'propr/new', prLabel: 'AI-PR', paths: ['src/shared.ts', 'README.md'],
    });
    assert.match(note, /^### ⚠️ Also being changed elsewhere/);
    assert.match(note, /- Active task task-other: `src\/shared\.ts`$/m);
    assert.match(note, /- Open PR #7: `README\.md`, `src\/shared\.ts`$/m);
    // Unlabelled PRs, the PR's own branch and stale registrations are not compared.
    assert.doesNotMatch(note, /#8|#9|task-stale|task-new/);
    assert.deepEqual(octokit.requests, ['GET /repos/{owner}/{repo}/pulls', 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files 7']);
});

test('without overlap, changes or a connected Redis the note is empty or limited to what can be read', async () => {
    const base = { octokit: fakeOctokit(), repoOwner: 'acme', repoName: 'widget', taskId: 'task-new', branchName: 'propr/new', prLabel: 'AI-PR' };
    assert.equal(await buildPullRequestOverlapNote({ ...base, redis: fakeRedis() as never, paths: ['docs/unique.md'] }), '');
    assert.equal(await buildPullRequestOverlapNote({ ...base, redis: fakeRedis() as never, paths: [] }), '');
    const offline = await buildPullRequestOverlapNote({ ...base, redis: fakeRedis('reconnecting') as never, paths: ['src/shared.ts'] });
    assert.doesNotMatch(offline, /Active task/);
    assert.match(offline, /Open PR #7/);
    const failing = await buildPullRequestOverlapNote({ ...base, octokit: { request: async () => { throw new Error('GitHub down'); } }, redis: null, paths: ['src/shared.ts'] });
    assert.equal(failing, '');
});

test('the note is appended only when the body still fits', () => {
    assert.equal(appendOverlapNote('body', '', 100), 'body');
    assert.equal(appendOverlapNote('body', 'note', 100), 'body\n\n---\n\nnote');
    assert.equal(appendOverlapNote('body', 'note', 10), 'body');
});
