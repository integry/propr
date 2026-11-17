import { readFileSync } from 'node:fs';
import { after, describe, test, mock } from 'node:test';
import assert from 'node:assert';
import { closeConnection } from '../packages/core/src/db/connection.js';
import {
    buildCiFailureDedupeKey,
    buildCiFailureFollowupMarker,
    extractCheckRunFailure,
    extractStatusFailure,
    isCiFailureFollowupComment,
    postCiFailureFollowup,
    stripCiFailureFollowupMarker,
    type CiFailureFollowupRequest,
} from '../packages/core/src/webhook/ciFailureFollowup.js';
import { loadProprCancelledRuns } from '../packages/core/src/webhook/ciCancellationProvenance.js';

after(async () => {
    await closeConnection();
});

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
        get: mock.fn(async (key: string) => values.get(key) ?? null),
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
        const requestsBeforeRedelivery = octokit.request.mock.callCount();
        const paginationBeforeRedelivery = octokit.paginate.mock.callCount();
        const redelivery = await postCiFailureFollowup(createRequest(), 'redelivery-test', dependencies);

        assert.strictEqual(octokit.request.mock.callCount(), requestsBeforeRedelivery);
        assert.strictEqual(octokit.paginate.mock.callCount(), paginationBeforeRedelivery);
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

    test('a failed Redis pre-check still uses the atomic claim', async () => {
        const redis = createRedis();
        redis.get.mock.mockImplementation(async () => { throw new Error('GET unavailable'); });
        const octokit = {
            paginate: async () => [],
            request: mock.fn(async () => ({ data: {} })),
        };
        const dependencies = {
            isEnabled: async () => true,
            getOctokit: async () => octokit,
            redisClient: redis as never,
        };
        const results = await Promise.all([
            postCiFailureFollowup(createRequest(), 'concurrent-a', dependencies),
            postCiFailureFollowup(createRequest(), 'concurrent-b', dependencies),
        ]);
        assert.strictEqual(results.filter(result => result.posted).length, 1);
        assert.strictEqual(results.filter(result => result.reason === 'duplicate').length, 1);
        assert.strictEqual(redis.set.mock.callCount(), 2);
        assert.strictEqual(redis.del.mock.callCount(), 0);
    });

    test('recognizes and strips only the hidden CI control marker', () => {
        const request = createRequest();
        const marker = buildCiFailureFollowupMarker(buildCiFailureDedupeKey(request));
        const body = `Please fix the failing test.\n\n${marker}`;

        assert.strictEqual(isCiFailureFollowupComment(body), true);
        assert.strictEqual(stripCiFailureFollowupMarker(body), 'Please fix the failing test.');
    });

    test('treats an intentionally cancelled check run as no failure at all', () => {
        // ProPR cancels obsolete pull request validation while a follow-up
        // implements. That cancellation must never become a corrective task.
        const payload = {
            action: 'completed',
            repository: { full_name: 'integry/propr' },
            check_run: {
                id: 42,
                name: 'desktop-validation',
                conclusion: 'cancelled',
                head_sha: '0123456789abcdef0123456789abcdef01234567',
                details_url: 'https://github.com/integry/propr/actions/runs/35915670035',
                html_url: 'https://github.com/integry/propr/actions/runs/35915670035',
                output: { title: null, summary: null, text: null, annotations_count: 0 },
            },
        };

        assert.strictEqual(extractCheckRunFailure(payload as never), null);
        assert.notStrictEqual(extractCheckRunFailure({
            ...payload,
            check_run: { ...payload.check_run, conclusion: 'failure' },
        } as never), null);
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

/**
 * Run 38090559848 at 8413598: ProPR cancelled the Full Test Suite while a
 * follow-up implemented, and the `always()` aggregate then failed closed on the
 * cancelled shards. Job 114326002000 is that aggregate.
 */
describe('cancellation-induced aggregate failure', () => {
    const RUN_ID = 38090559848;
    const AGGREGATE_JOB_ID = 114326002000;

    function aggregateRequest(state = 'failure'): CiFailureFollowupRequest {
        return {
            owner: 'integry',
            repo: 'propr',
            prNumber: 2953,
            evidence: {
                kind: 'check_run',
                name: 'Run Full Test Suite',
                state,
                sha: '8413598e20599fa42d316ef826627bd8769edc47',
                url: `https://github.com/integry/propr/actions/runs/${RUN_ID}/job/${AGGREGATE_JOB_ID}`,
                source: 'check-run:Run Full Test Suite',
                fallbackExcerpt: "Shard coverage verification finished with result 'failure'.",
                checkRunId: AGGREGATE_JOB_ID,
                annotationsCount: 0,
            },
        };
    }

    interface Job { id: number; name: string; conclusion: string; completed_at: string }

    function cancelledRunJobs(overrides: Partial<Record<string, Partial<Job>>> = {}): Job[] {
        const jobs: Job[] = [
            { id: 1, name: 'Classify changed surfaces', conclusion: 'success', completed_at: '2026-10-10T20:00:30Z' },
            { id: 2, name: 'Validate Docs Site', conclusion: 'success', completed_at: '2026-10-10T20:04:00Z' },
            { id: 3, name: 'Full Test Suite Shard 1/4', conclusion: 'cancelled', completed_at: '2026-10-10T20:06:00Z' },
            { id: 4, name: 'Full Test Suite Shard 2/4', conclusion: 'cancelled', completed_at: '2026-10-10T20:06:01Z' },
            { id: 5, name: 'Full Test Suite Native Electron (hosted)', conclusion: 'cancelled', completed_at: '2026-10-10T20:06:02Z' },
            { id: AGGREGATE_JOB_ID, name: 'Run Full Test Suite', conclusion: 'failure', completed_at: '2026-10-10T20:07:00Z' },
            { id: 7, name: 'Report Full Test Failure', conclusion: 'skipped', completed_at: '2026-10-10T20:07:05Z' },
        ];
        return jobs.map(job => ({ ...job, ...overrides[job.name] }));
    }

    /** The failure annotations GitHub recorded for job 114326002000. */
    const AGGREGATE_ANNOTATIONS = [
        { annotation_level: 'warning', message: 'Node.js 20 is deprecated.' },
        { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
        { annotation_level: 'failure', message: "Shard coverage verification finished with result 'failure'." },
        { annotation_level: 'failure', message: "Hosted native Electron units finished with result 'cancelled'." },
        { annotation_level: 'failure', message: "Docs site validation finished with result 'cancelled'." },
        { annotation_level: 'failure', message: "Full test suite shards finished with result 'cancelled'." },
        { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
    ];

    interface Step { name: string; conclusion: string | null }

    /** The aggregate's steps: coverage and the gate fail on the cancelled shards. */
    function aggregateSteps(extra: Step[] = []): Step[] {
        return [
            { name: 'Set up job', conclusion: 'success' },
            { name: 'Checkout repository', conclusion: 'success' },
            { name: 'Set up Node.js', conclusion: 'success' },
            { name: 'Download shard summaries', conclusion: 'success' },
            { name: 'Verify shards ran every discovered test exactly once', conclusion: 'failure' },
            ...extra,
            { name: 'Enforce shard and docs results', conclusion: 'failure' },
            { name: 'Post Checkout repository', conclusion: 'success' },
            { name: 'Complete job', conclusion: 'success' },
        ];
    }

    function actionsOctokit(options: {
        jobs: Job[];
        /** The target check run's annotations; the actual aggregate's by default. */
        annotations?: Array<{ annotation_level: string; message: string }>;
        failAnnotations?: boolean;
        runAttempt?: number;
        attemptConclusion?: string;
        failJobLookup?: boolean;
        /** The fetched job's conclusion when it disagrees with the attempt's job listing. */
        jobLookupConclusion?: string;
        /** The fetched job's steps; the actual aggregate's by default. */
        steps?: Step[];
    }) {
        const postedBodies: string[] = [];
        const runAttempt = options.runAttempt ?? 1;
        const aggregate = options.jobs.find(job => job.id === AGGREGATE_JOB_ID)!;
        const octokit = {
            paginate: mock.fn(async () => []),
            request: mock.fn(async (route: string, parameters: Record<string, unknown>) => {
                if (route.startsWith('POST ')) {
                    postedBodies.push(String(parameters.body));
                    return { data: {} };
                }
                if (route === 'GET /repos/{owner}/{repo}/actions/jobs/{job_id}') {
                    if (options.failJobLookup) throw new Error('HTTP 502');
                    return { data: { id: AGGREGATE_JOB_ID, run_id: RUN_ID, run_attempt: runAttempt, conclusion: options.jobLookupConclusion ?? aggregate.conclusion, completed_at: aggregate.completed_at, steps: options.steps ?? aggregateSteps() } };
                }
                if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}') {
                    // The aggregate finishes while the run still evaluates its report job.
                    const conclusion = options.attemptConclusion ?? null;
                    return { data: { id: RUN_ID, run_attempt: parameters.attempt_number, status: conclusion ? 'completed' : 'in_progress', conclusion } };
                }
                if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs') {
                    return { data: { total_count: options.jobs.length, jobs: options.jobs } };
                }
                if (route === 'GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations') {
                    if (options.failAnnotations) throw new Error('HTTP 502');
                    assert.strictEqual(parameters.check_run_id, AGGREGATE_JOB_ID);
                    return { data: parameters.page === 1 ? options.annotations ?? AGGREGATE_ANNOTATIONS : [] };
                }
                throw new Error(`unexpected route ${route}`);
            }),
        };
        return { octokit, postedBodies };
    }

    async function follow(
        octokit: ReturnType<typeof actionsOctokit>['octokit'],
        cancelledRuns: Array<{ id: number; observedAttempt?: number; attempt?: number; restarted?: boolean }>,
        reportedState = 'failure',
    ) {
        const redis = createRedis();
        const result = await postCiFailureFollowup(aggregateRequest(reportedState), 'cancellation-test', {
            isEnabled: mock.fn(async () => true),
            getOctokit: mock.fn(async () => octokit),
            redisClient: redis as never,
            loadProprCancelledRuns: mock.fn(async () => cancelledRuns),
        });
        return { result, redis };
    }

    test('does not start a follow-up when ProPR suspended the run and the aggregate failed on cancelled shards', async () => {
        const { octokit, postedBodies } = actionsOctokit({ jobs: cancelledRunJobs() });

        const { result, redis } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1, restarted: false }]);

        assert.deepStrictEqual(result, { posted: false, reason: 'cancellation_induced' });
        assert.strictEqual(postedBodies.length, 0);
        // No dedupe claim: a genuine failure on a restored attempt of this head must still be reported.
        assert.strictEqual(redis.set.mock.callCount(), 0);
    });

    test('does not start a follow-up for a late event of an attempt cancelled outside ProPR', async () => {
        const { octokit, postedBodies } = actionsOctokit({ jobs: cancelledRunJobs(), attemptConclusion: 'cancelled' });

        const { result } = await follow(octokit, []);

        assert.deepStrictEqual(result, { posted: false, reason: 'cancellation_induced' });
        assert.strictEqual(postedBodies.length, 0);
    });

    test('still posts when a shard genuinely failed in the cancelled run', async () => {
        const { octokit, postedBodies } = actionsOctokit({
            jobs: cancelledRunJobs({ 'Full Test Suite Shard 2/4': { conclusion: 'failure', completed_at: '2026-10-10T20:05:00Z' } }),
        });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
        assert.strictEqual(postedBodies.length, 1);
    });

    test('still posts a timed-out sibling job next to the cancellation', async () => {
        const { octokit } = actionsOctokit({
            jobs: cancelledRunJobs({ 'Validate Docs Site': { conclusion: 'timed_out' } }),
        });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
    });

    test('still posts a job that failed before the cancellation landed', async () => {
        const { octokit } = actionsOctokit({
            jobs: cancelledRunJobs({ 'Run Full Test Suite': { completed_at: '2026-10-10T20:05:00Z' } }),
        });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
    });

    test('still posts a job that kept running past the cancellation and failed its own assertion', async () => {
        // A job under `always()` fails on its own after a needed job was
        // cancelled; correlation in time is not causation.
        const { octokit, postedBodies } = actionsOctokit({
            jobs: cancelledRunJobs(),
            annotations: [
                { annotation_level: 'failure', message: 'AssertionError: expected the migration to apply cleanly' },
                { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
            ],
        });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
        assert.strictEqual(postedBodies.length, 1);
    });

    test('still posts an aggregate whose own failure accompanies its cancelled dependencies', async () => {
        const { octokit } = actionsOctokit({
            jobs: cancelledRunJobs(),
            annotations: [
                ...AGGREGATE_ANNOTATIONS,
                { annotation_level: 'failure', message: 'Unexpected skipped shard 3/4.' },
            ],
        });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
    });

    test('still posts an aggregate whose own shell step failed before its cancelled-dependency gate', async () => {
        // A plain shell assertion reports nothing but its exit code; the gate
        // that runs after it under `always()` then reports the cancelled shards.
        const steps = aggregateSteps([{ name: 'Check release notes', conclusion: 'failure' }]);
        const { octokit, postedBodies } = actionsOctokit({
            jobs: cancelledRunJobs(),
            steps,
            annotations: [
                { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
                { annotation_level: 'failure', message: "Full test suite shards finished with result 'cancelled'." },
                { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
            ],
        });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
        assert.strictEqual(postedBodies.length, 1);
    });

    test('still posts an aggregate whose shell failure reports only an exit code past the recognized steps', async () => {
        // The step listing attributes no failure elsewhere, but there are more
        // exit-code notices than recognized steps that ran.
        const { octokit } = actionsOctokit({
            jobs: cancelledRunJobs(),
            annotations: [...AGGREGATE_ANNOTATIONS, { annotation_level: 'failure', message: 'Process completed with exit code 2.' }],
        });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
    });

    for (const [label, steps] of [
        ['missing', []],
        ['unconcluded', aggregateSteps([{ name: 'Check release notes', conclusion: null }])],
        ['passing at the gate', aggregateSteps().map(step => step.name === 'Enforce shard and docs results' ? { ...step, conclusion: 'success' } : step)],
    ] as Array<[string, Step[]]>) {
        test(`still posts when the aggregate's failed steps are ${label}`, async () => {
            const { octokit } = actionsOctokit({ jobs: cancelledRunJobs(), steps });

            const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

            assert.strictEqual(result.reason, 'posted');
        });
    }

    test('still posts a target whose only failure is its exit code', async () => {
        const { octokit } = actionsOctokit({
            jobs: cancelledRunJobs(),
            attemptConclusion: 'cancelled',
            annotations: [{ annotation_level: 'failure', message: 'Process completed with exit code 1.' }],
        });

        const { result } = await follow(octokit, []);

        assert.strictEqual(result.reason, 'posted');
    });

    test('posts when the failed check annotations cannot be read', async () => {
        const { octokit } = actionsOctokit({ jobs: cancelledRunJobs(), failAnnotations: true });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
    });

    test('still posts when nothing deliberately cancelled the attempt', async () => {
        // A shard stopped by its own timeout also reads `cancelled`, but the attempt
        // is not cancelled and ProPR recorded no cancellation.
        const { octokit } = actionsOctokit({ jobs: cancelledRunJobs(), attemptConclusion: 'failure' });

        const { result } = await follow(octokit, [{ id: 999, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
    });

    test('judges the attempt ProPR reran to restore validation on its own', async () => {
        const { octokit } = actionsOctokit({ jobs: cancelledRunJobs(), runAttempt: 2, attemptConclusion: 'failure' });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1, attempt: 1, restarted: true }]);

        assert.strictEqual(result.reason, 'posted');
    });

    for (const conclusion of ['timed_out', 'startup_failure', 'action_required']) {
        test(`still posts a ${conclusion} target despite the cancellation evidence`, async () => {
            const { octokit, postedBodies } = actionsOctokit({
                jobs: cancelledRunJobs({ 'Run Full Test Suite': { conclusion } }),
                attemptConclusion: 'cancelled',
            });

            const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }], conclusion);

            assert.strictEqual(result.reason, 'posted');
            assert.strictEqual(postedBodies.length, 1);
        });
    }

    test('still posts a target reported failed whose fetched job timed out', async () => {
        const { octokit } = actionsOctokit({ jobs: cancelledRunJobs(), attemptConclusion: 'cancelled', jobLookupConclusion: 'timed_out' });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
    });

    test('still posts a target reported timed out whose fetched job reads failure', async () => {
        const { octokit } = actionsOctokit({ jobs: cancelledRunJobs(), attemptConclusion: 'cancelled' });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }], 'timed_out');

        assert.strictEqual(result.reason, 'posted');
    });

    test('still posts a failed target the attempt job listing records as timed out', async () => {
        const { octokit } = actionsOctokit({
            jobs: cancelledRunJobs({ 'Run Full Test Suite': { conclusion: 'timed_out' } }),
            attemptConclusion: 'cancelled',
            jobLookupConclusion: 'failure',
        });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
    });

    test('posts when the cancellation provenance cannot be read', async () => {
        const { octokit } = actionsOctokit({ jobs: cancelledRunJobs(), failJobLookup: true });

        const { result } = await follow(octokit, [{ id: RUN_ID, observedAttempt: 1 }]);

        assert.strictEqual(result.reason, 'posted');
    });
});

test('the webhook reads the runs the worker recorded for its follow-up suspension', async () => {
    const knex = (await import('knex')).default;
    const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
        await (await import('../packages/core/src/db/migrations/20260923010000_add_pr_ci_suspensions.js')).up(database);
        await (await import('../packages/core/src/db/migrations/20260924010000_add_ci_suspension_incarnation.js')).up(database);
        const { reserveSuspension, saveCancelledRuns } = await import('../src/jobs/followupCiSuspensionStore.js');
        const reserved = await reserveSuspension({
            target: { owner: 'Integry', repo: 'ProPR', pullRequestNumber: 2953 },
            headSha: '8413598e20599fa42d316ef826627bd8769edc47',
            taskId: 'pr-comments-batch-integry-propr-2953',
        }, { database });
        assert.ok(reserved);
        await saveCancelledRuns({ database }, reserved.record, [{ id: 38090559848, observedAttempt: 1, restarted: false }]);

        assert.deepStrictEqual(
            await loadProprCancelledRuns('integry/propr', 2953, database),
            [{ id: 38090559848, observedAttempt: 1, restarted: false }],
        );
        assert.deepStrictEqual(await loadProprCancelledRuns('integry/propr', 2954, database), []);
    } finally {
        await database.destroy();
    }
});

test('recognized cancellation gate steps match the workflow', () => {
    const source = readFileSync(new URL('../packages/core/src/webhook/ciCancellationProvenance.ts', import.meta.url), 'utf8');
    const workflow = readFileSync(new URL('../.github/workflows/pr-test-on-label.yml', import.meta.url), 'utf8');
    for (const constant of ['DEPENDENCY_GATE_STEPS', 'CANCELLATION_CONSEQUENCE_STEPS']) {
        const values = source.match(new RegExp(`const ${constant} = new Set\\(\\[([^\\]]+)\\]\\)`));
        assert.ok(values, constant);
        const names = [...values[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
        assert.ok(names.length > 0);
        for (const name of names) assert.ok(workflow.includes(`- name: ${name}\n`), name);
    }
});
