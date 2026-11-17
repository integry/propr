import { after, describe, test, mock } from 'node:test';
import assert from 'node:assert';
import { closeConnection } from '../packages/core/src/db/connection.js';
import {
    buildCiFailureDedupeKey,
    buildCiFailureFollowupMarker,
    isCiFailureFollowupComment,
    postCiFailureFollowup,
    stripCiFailureFollowupMarker,
    type CiFailureEvidence,
    type CiFailureFollowupRequest,
} from '../packages/core/src/webhook/ciFailureFollowup.js';
import { buildCiFailureHeadMarker } from '../packages/core/src/webhook/ciFailureCommentGrouping.js';
import { handleCommentEdited } from '../packages/core/src/webhook/commentEventHandler.js';

after(async () => {
    await closeConnection();
});

const HEAD = '91f89c3b9e1d2c3b4a5f60718293a4b5c6d7e8f9';
const RUN_ID = 555;

function failure(name: string, jobId: number, overrides: Partial<CiFailureEvidence> = {}): CiFailureFollowupRequest {
    return {
        owner: 'integry',
        repo: 'propr',
        prNumber: 3434,
        evidence: {
            kind: 'check_run',
            name,
            state: 'failure',
            sha: HEAD,
            url: `https://github.com/integry/propr/actions/runs/${RUN_ID}/job/${jobId}`,
            source: `check-run:${name}`,
            fallbackExcerpt: `${name} failed its assertions`,
            checkRunId: jobId,
            annotationsCount: 0,
            ...overrides,
        },
    };
}

interface StoredComment { id: number; body: string; user: { login: string } }

/** A GitHub stub that keeps the PR's comments, so reads see earlier writes. */
function fakeGitHub(options: {
    failList?: boolean;
    failEdit?: boolean;
    comments?: StoredComment[];
} = {}) {
    const comments: StoredComment[] = options.comments ?? [];
    const posts: string[] = [];
    const edits: Array<{ id: number; body: string }> = [];
    const octokit = {
        paginate: mock.fn(async (route: string) => {
            if (route.includes('/comments')) {
                if (options.failList) throw new Error('HTTP 502 listing comments');
                return comments.map(comment => ({ ...comment }));
            }
            return [];
        }),
        request: mock.fn(async (route: string, parameters: Record<string, unknown>) => {
            if (route.startsWith('POST ')) {
                const body = String(parameters.body);
                posts.push(body);
                comments.push({ id: 1000 + comments.length, body, user: { login: 'propr-dev[bot]' } });
                return { data: {} };
            }
            if (route.startsWith('PATCH ')) {
                if (options.failEdit) throw new Error('HTTP 502 editing comment');
                const body = String(parameters.body);
                edits.push({ id: parameters.comment_id as number, body });
                const comment = comments.find(entry => entry.id === parameters.comment_id);
                if (comment) comment.body = body;
                return { data: {} };
            }
            if (route === 'GET /repos/{owner}/{repo}/actions/jobs/{job_id}') {
                const jobId = parameters.job_id as number;
                // Nothing is cancelled here, so the provenance check stops at the job's conclusion.
                return { data: { id: jobId, run_id: RUN_ID, run_attempt: 1, conclusion: 'failure', completed_at: '2026-11-17T10:00:00Z', steps: [] } };
            }
            if (route === 'GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations') {
                return { data: [] };
            }
            if (route.includes('/actions/runs/')) {
                return { data: { status: 'completed', conclusion: 'failure', total_count: 0, jobs: [] } };
            }
            throw new Error(`unexpected route ${route}`);
        }),
    };
    return { octokit, comments, posts, edits };
}

function createRedis() {
    const values = new Map<string, string>();
    return {
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string, ...args: Array<string | number>) => {
            if (args.includes('NX') && values.has(key)) return null;
            values.set(key, value);
            return 'OK';
        },
        del: async (key: string) => values.delete(key) ? 1 : 0,
    };
}

function dependencies(octokit: ReturnType<typeof fakeGitHub>['octokit'], redisClient = createRedis()) {
    return {
        isEnabled: async () => true,
        getOctokit: async () => octokit,
        redisClient: redisClient as never,
        loadProprCancelledRuns: async () => [],
    };
}

describe('one CI-failure comment per head commit', () => {
    test('a second failing check of the same head edits the first comment instead of posting', async () => {
        const github = fakeGitHub();
        const deps = dependencies(github.octokit);

        const first = await postCiFailureFollowup(failure('Full Test Suite Shard 1/4', 11), 'first', deps);
        const second = await postCiFailureFollowup(failure('Lint', 12), 'second', deps);

        assert.strictEqual(first.reason, 'posted');
        assert.strictEqual(second.reason, 'updated');
        assert.strictEqual(github.posts.length, 1, 'only one comment, so only one follow-up run');
        assert.strictEqual(github.edits.length, 1);
        assert.strictEqual(github.edits[0].id, github.comments[0].id);
        const body = github.comments[0].body;
        assert.ok(body.startsWith('CI failed: **Full Test Suite Shard 1/4**, **Lint**\n'));
        assert.match(body, /Lint failed its assertions/);
        assert.ok(body.includes(buildCiFailureHeadMarker(HEAD)));
        assert.ok(isCiFailureFollowupComment(body));

        // A redelivery of the second check finds it on the edited comment.
        const redelivered = await postCiFailureFollowup(failure('Lint', 12), 'redelivery', dependencies(github.octokit));
        assert.strictEqual(redelivered.reason, 'duplicate');
        assert.strictEqual(github.edits.length, 1);
    });

    test('a new head commit gets a new comment', async () => {
        const github = fakeGitHub();
        const deps = dependencies(github.octokit);
        const nextHead = 'aaaabbbbccccddddeeeeffff0000111122223333';

        await postCiFailureFollowup(failure('Lint', 12), 'old-head', deps);
        const result = await postCiFailureFollowup(failure('Lint', 21, { sha: nextHead }), 'new-head', deps);

        assert.strictEqual(result.reason, 'posted');
        assert.strictEqual(github.posts.length, 2);
        assert.strictEqual(github.edits.length, 0);
        assert.ok(github.posts[1].includes(buildCiFailureHeadMarker(nextHead)));
        assert.ok(!github.posts[1].includes(buildCiFailureHeadMarker(HEAD)));
    });

    test('a failing aggregate job is listed next to its own shard like any other check', async () => {
        const github = fakeGitHub();
        const deps = dependencies(github.octokit);

        await postCiFailureFollowup(failure('Full Test Suite Shard 2/4', 11), 'shard', deps);
        const aggregate = await postCiFailureFollowup(failure('Run Full Test Suite', 99), 'aggregate', deps);

        assert.strictEqual(aggregate.reason, 'updated');
        assert.strictEqual(github.posts.length, 1);
        assert.ok(github.comments[0].body.startsWith('CI failed: **Full Test Suite Shard 2/4**, **Run Full Test Suite**\n'));
    });

    test('a comment-list failure falls back to posting a new comment', async () => {
        const github = fakeGitHub({ failList: true, comments: [] });
        const deps = dependencies(github.octokit);

        await postCiFailureFollowup(failure('Lint', 12), 'first', deps);
        const result = await postCiFailureFollowup(failure('Typecheck', 13), 'second', deps);

        assert.strictEqual(result.reason, 'posted');
        assert.strictEqual(github.posts.length, 2);
    });

    test('an edit failure falls back to posting a new comment', async () => {
        const github = fakeGitHub({ failEdit: true });
        const deps = dependencies(github.octokit);

        await postCiFailureFollowup(failure('Lint', 12), 'first', deps);
        const result = await postCiFailureFollowup(failure('Typecheck', 13), 'second', deps);

        assert.strictEqual(result.reason, 'posted');
        assert.strictEqual(github.posts.length, 2);
        assert.match(github.posts[1], /^CI failed: \*\*Typecheck\*\*\n/);
    });

    test('a same-head comment by someone else is not edited', async () => {
        const github = fakeGitHub({
            comments: [{ id: 7, body: `CI failed: **Lint**\n${buildCiFailureHeadMarker(HEAD)}`, user: { login: 'someone' } }],
        });

        const result = await postCiFailureFollowup(failure('Typecheck', 13), 'foreign', dependencies(github.octokit));

        assert.strictEqual(result.reason, 'posted');
        assert.strictEqual(github.edits.length, 0);
    });

    test('five listed checks keep every marker and a readable body', async () => {
        const github = fakeGitHub();
        const deps = dependencies(github.octokit);
        const names = ['Shard 1/4', 'Shard 2/4', 'Lint', 'Typecheck', 'Docs'];
        for (const [index, name] of names.entries()) {
            await postCiFailureFollowup(failure(name, 40 + index), name, deps);
        }

        assert.strictEqual(github.posts.length, 1);
        assert.strictEqual(github.edits.length, 4);
        const body = github.comments[0].body;
        assert.strictEqual(body.split('\n')[0], `CI failed: ${names.map(name => `**${name}**`).join(', ')}`);
        assert.ok(body.includes('Please investigate and fix these CI failures.'));
        assert.strictEqual(body.split(buildCiFailureHeadMarker(HEAD)).length - 1, 1);
        for (const [index, name] of names.entries()) {
            assert.ok(body.includes(buildCiFailureFollowupMarker(buildCiFailureDedupeKey(failure(name, 40 + index)))), name);
            assert.ok(body.includes(`- Check: \`${name}\``), name);
            assert.ok(body.includes(`(https://github.com/integry/propr/actions/runs/${RUN_ID}/job/${40 + index})`), name);
        }
        // The commit is named once; each later check is set off by a rule.
        assert.strictEqual(body.split('- Commit: ').length - 1, 1);
        assert.strictEqual(body.split('\n---\n').length - 1, 4);
        // Markers stay at the end, and stripping them leaves only readable text.
        const visible = stripCiFailureFollowupMarker(body);
        assert.doesNotMatch(visible, /<!--/);
        assert.ok(body.slice(visible.length).trim().split('\n').every(line => line.startsWith('<!-- propr:ci-failure-')));
        assert.ok(isCiFailureFollowupComment(body));
    });
});

test('editing ProPR\'s CI-failure comment starts no new follow-up', { timeout: 10_000 }, async () => {
    const processCommentEvent = mock.fn(async () => undefined);
    const redisClient = { set: mock.fn(), del: mock.fn() };
    const editedPayload = (login: string) => ({
        action: 'edited',
        repository: { owner: { login: 'integry' }, name: 'propr' },
        issue: { number: 3434, pull_request: {} },
        comment: { id: 1000, body: `CI failed: **Lint**, **Typecheck**\n\n${buildCiFailureHeadMarker(HEAD)}\n${buildCiFailureFollowupMarker('a'.repeat(64))}`, user: { login } },
    });

    await handleCommentEdited(editedPayload('propr-dev[bot]') as never, 'issue_comment', 'edit-test', {
        redisClient: redisClient as never,
        PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
        processCommentEvent: processCommentEvent as never,
    });

    assert.strictEqual(processCommentEvent.mock.callCount(), 0);
    assert.strictEqual(redisClient.set.mock.callCount(), 0);
    assert.strictEqual(redisClient.del.mock.callCount(), 0);
});
