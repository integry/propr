import { describe, test, mock } from 'node:test';
import assert from 'node:assert';
import {
    buildCiFailureDedupeKey,
    buildCiFailureFollowupMarker,
    extractStatusFailure,
    isCiFailureFollowupComment,
    postCiFailureFollowup,
    stripCiFailureFollowupMarker,
    type CiFailureFollowupRequest,
} from '../packages/core/src/webhook/ciFailureFollowup.js';

function createRequest(): CiFailureFollowupRequest {
    return {
        owner: 'integry',
        repo: 'propr',
        prNumber: 1927,
        evidence: {
            kind: 'check_run',
            name: 'unit-tests',
            state: 'failure',
            sha: '0123456789abcdef0123456789abcdef01234567',
            url: 'https://github.com/integry/propr/actions/runs/123',
            source: 'check-run:unit-tests',
            fallbackExcerpt: 'A long, generic job summary',
            checkRunId: 123,
            annotationsCount: 1,
        },
    };
}

function createRedis() {
    const values = new Map<string, string>();
    return {
        set: mock.fn(async (key: string, value: string, ...args: Array<string | number>) => {
            if (args.includes('NX') && values.has(key)) return null;
            values.set(key, value);
            return 'OK';
        }),
        del: mock.fn(async (key: string) => values.delete(key) ? 1 : 0),
    };
}

describe('automatic failed-CI follow-up', () => {
    test('does not access GitHub or Redis when the repository option is disabled', async () => {
        const getOctokit = mock.fn(async () => { throw new Error('must not be called'); });
        const redis = createRedis();

        const result = await postCiFailureFollowup(createRequest(), 'disabled-test', {
            isEnabled: mock.fn(async () => false),
            getOctokit,
            redisClient: redis as never,
        });

        assert.deepStrictEqual(result, { posted: false, reason: 'disabled' });
        assert.strictEqual(getOctokit.mock.callCount(), 0);
        assert.strictEqual(redis.set.mock.callCount(), 0);
    });

    test('posts annotation evidence and deduplicates a redelivered webhook', async () => {
        const postedBodies: string[] = [];
        const octokit = {
            paginate: mock.fn(async (route: string) => route.includes('annotations')
                ? [{
                    annotation_level: 'failure',
                    path: 'src/worker.ts',
                    start_line: 88,
                    title: 'Assertion failed',
                    message: 'expected 2 jobs but received 1',
                }]
                : []),
            request: mock.fn(async (route: string, options: Record<string, unknown>) => {
                if (route.startsWith('POST ')) postedBodies.push(String(options.body));
                return { data: {} };
            }),
        };
        const redis = createRedis();
        const dependencies = {
            isEnabled: mock.fn(async () => true),
            getOctokit: mock.fn(async () => octokit),
            redisClient: redis as never,
        };

        const first = await postCiFailureFollowup(createRequest(), 'enabled-test', dependencies);
        const redelivery = await postCiFailureFollowup(createRequest(), 'redelivery-test', dependencies);

        assert.strictEqual(first.posted, true);
        assert.deepStrictEqual(redelivery, { posted: false, reason: 'duplicate' });
        assert.strictEqual(postedBodies.length, 1);
        assert.match(postedBodies[0], /unit-tests/);
        assert.match(postedBodies[0], /failure/);
        assert.match(postedBodies[0], /0123456789abcdef0123456789abcdef01234567/);
        assert.match(postedBodies[0], /src\/worker\.ts:88/);
        assert.match(postedBodies[0], /expected 2 jobs but received 1/);
        assert.doesNotMatch(postedBodies[0], /long, generic job summary/);
        assert.ok(isCiFailureFollowupComment(postedBodies[0]));
    });

    test('recognizes and strips only the hidden CI control marker', () => {
        const request = createRequest();
        const marker = buildCiFailureFollowupMarker(buildCiFailureDedupeKey(request));
        const body = `Please fix the failing test.\n\n${marker}`;

        assert.strictEqual(isCiFailureFollowupComment(body), true);
        assert.strictEqual(stripCiFailureFollowupMarker(body), 'Please fix the failing test.');
    });

    test('extracts failure and error legacy statuses but not pending statuses', () => {
        const payload = {
            sha: 'abc123',
            state: 'error',
            context: 'legacy-ci',
            description: 'runner could not start',
            target_url: 'https://ci.example/run/1',
            repository: { full_name: 'integry/propr' },
        };

        assert.deepStrictEqual(extractStatusFailure(payload), {
            kind: 'status',
            name: 'legacy-ci',
            state: 'error',
            sha: 'abc123',
            url: 'https://ci.example/run/1',
            source: 'status:legacy-ci',
            fallbackExcerpt: 'runner could not start',
        });
        assert.strictEqual(extractStatusFailure({ ...payload, state: 'pending' }), null);
    });
});
