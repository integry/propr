import { after, describe, test, mock } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { closeConnection } from '../packages/core/src/db/connection.js';
import {
    decideAggregateFold,
    loadAggregateFold,
    parseWorkflowJobs,
    type JobStep,
    type ParsedWorkflow,
    type RunJob,
} from '../packages/core/src/webhook/ciFailureAggregateFold.js';
import {
    postCiFailureFollowup,
    stripCiFailureFollowupMarker,
    type CiFailureFollowupRequest,
} from '../packages/core/src/webhook/ciFailureFollowup.js';

after(async () => {
    await closeConnection();
});

const WORKFLOW_PATH = '.github/workflows/pr-test-on-label.yml';
/** This repository's own Full Test Suite workflow: four matrix shards and the `Run Full Test Suite` aggregate. */
const WORKFLOW_TEXT = readFileSync(new URL(`../${WORKFLOW_PATH}`, import.meta.url), 'utf8');
const HEAD = '91f89c3b9e1d2c3b4a5f60718293a4b5c6d7e8f9';
const RUN_ID = 777;
const AGGREGATE_ID = 900;
const AGGREGATE = 'Run Full Test Suite';
const GATE = 'Enforce shard and docs results';
const COVERAGE = 'Verify shards ran every discovered test exactly once';

function workflow(): ParsedWorkflow {
    const parsed = parseWorkflowJobs(WORKFLOW_TEXT);
    assert.ok(parsed, 'the repository workflow parses');
    return parsed;
}

function runJobs(failedShards: number[]): RunJob[] {
    return [
        { id: 1, name: 'Classify changed surfaces', conclusion: 'success' },
        { id: 2, name: 'Select PR check runners', conclusion: 'skipped' },
        ...[1, 2, 3, 4].map(shard => ({
            id: 10 + shard,
            name: `Full Test Suite Shard ${shard}/4`,
            conclusion: failedShards.includes(shard) ? 'failure' : 'success',
            url: `https://github.com/integry/propr/actions/runs/${RUN_ID}/job/${10 + shard}`,
        })),
        { id: 20, name: 'Validate Docs Site', conclusion: 'success' },
        { id: 21, name: 'Full Test Suite Native Electron (hosted)', conclusion: 'skipped' },
        { id: AGGREGATE_ID, name: AGGREGATE, conclusion: 'failure' },
    ];
}

function aggregateSteps(failed: string[] = [GATE]): JobStep[] {
    return ['Set up job', 'Checkout repository', 'Set up Node.js', 'Download shard summaries', COVERAGE, GATE, 'Post Checkout repository', 'Complete job']
        .map(name => ({ name, conclusion: failed.includes(name) ? 'failure' : 'success' }));
}

describe('decideAggregateFold with the Full Test Suite layout', () => {
    test('one failed shard folds the aggregate under it', () => {
        const fold = decideAggregateFold({
            aggregate: { id: AGGREGATE_ID, name: AGGREGATE }, steps: aggregateSteps(), runJobs: runJobs([3]), workflow: workflow(),
        });
        assert.deepStrictEqual(fold?.aggregate, AGGREGATE);
        assert.deepStrictEqual(fold?.causes.map(cause => cause.name), ['Full Test Suite Shard 3/4']);
    });

    test('several failed shards are all listed as the cause', () => {
        const fold = decideAggregateFold({
            aggregate: { id: AGGREGATE_ID, name: AGGREGATE }, steps: aggregateSteps(), runJobs: runJobs([1, 4]), workflow: workflow(),
        });
        assert.deepStrictEqual(fold?.causes.map(cause => cause.id), [11, 14]);
    });

    test('an aggregate failing while no needed job failed is listed on its own', () => {
        const fold = decideAggregateFold({
            aggregate: { id: AGGREGATE_ID, name: AGGREGATE }, steps: aggregateSteps(), runJobs: runJobs([]), workflow: workflow(),
        });
        assert.strictEqual(fold, null);
    });

    test('an aggregate with a failed step of its own besides the gate is listed on its own', () => {
        const fold = decideAggregateFold({
            aggregate: { id: AGGREGATE_ID, name: AGGREGATE }, steps: aggregateSteps([COVERAGE, GATE]), runJobs: runJobs([3]), workflow: workflow(),
        });
        assert.strictEqual(fold, null);
    });

    test('an aggregate whose only failed step is not the gate is listed on its own', () => {
        const fold = decideAggregateFold({
            aggregate: { id: AGGREGATE_ID, name: AGGREGATE }, steps: aggregateSteps(['Set up Node.js']), runJobs: runJobs([3]), workflow: workflow(),
        });
        assert.strictEqual(fold, null);
    });

    test('an aggregate with no failed step is not proven to be only its gate', () => {
        const fold = decideAggregateFold({
            aggregate: { id: AGGREGATE_ID, name: AGGREGATE }, steps: aggregateSteps([]), runJobs: runJobs([3]), workflow: workflow(),
        });
        assert.strictEqual(fold, null);
    });

    test('a shard is never folded: it needs only the runner selection, which did not fail', () => {
        const fold = decideAggregateFold({
            aggregate: { id: 13, name: 'Full Test Suite Shard 3/4' },
            steps: [{ name: 'Run Full Test Suite shard', conclusion: 'failure' }],
            runJobs: runJobs([3]),
            workflow: workflow(),
        });
        assert.strictEqual(fold, null);
    });

    test('a job name that maps to more than one job id is not folded', () => {
        const ambiguous = parseWorkflowJobs(`${WORKFLOW_TEXT}\n  other:\n    name: Run Full Test Suite\n    needs: shard\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo\n`);
        assert.ok(ambiguous);
        const fold = decideAggregateFold({
            aggregate: { id: AGGREGATE_ID, name: AGGREGATE }, steps: aggregateSteps(), runJobs: runJobs([3]), workflow: ambiguous,
        });
        assert.strictEqual(fold, null);
    });

    test('matrix jobs without a templated name map through their appended values', () => {
        const parsed = parseWorkflowJobs([
            'jobs:',
            '  build:',
            '    strategy:',
            '      matrix:',
            '        os: [linux, mac]',
            '    steps: [{ run: make }]',
            '  gate:',
            '    needs: [build]',
            '    steps:',
            '      - name: Check build results',
            '        run: test "${{ needs.build.result }}" = success',
        ].join('\n'));
        assert.ok(parsed);
        const fold = decideAggregateFold({
            aggregate: { id: 3, name: 'gate' },
            steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Check build results', conclusion: 'failure' }],
            runJobs: [
                { id: 1, name: 'build (linux)', conclusion: 'failure' },
                { id: 2, name: 'build (mac)', conclusion: 'success' },
                { id: 3, name: 'gate', conclusion: 'failure' },
            ],
            workflow: parsed,
        });
        assert.deepStrictEqual(fold?.causes.map(cause => cause.name), ['build (linux)']);
    });

    test('unparsable or unexpected workflow text yields no workflow', () => {
        assert.strictEqual(parseWorkflowJobs('jobs: [\n'), null);
        assert.strictEqual(parseWorkflowJobs('name: no jobs here'), null);
        assert.strictEqual(parseWorkflowJobs('jobs:\n  a:\n    needs: 3\n'), null);
    });
});

/** GitHub for one Full Test Suite run whose shard 3 failed. */
function fakeGitHub(options: { workflowReadable?: boolean; aggregateFailedSteps?: string[] } = {}) {
    const comments: Array<{ id: number; body: string; user: { login: string } }> = [];
    const posts: string[] = [];
    const jobs = runJobs([3]);
    const contentsReads: unknown[] = [];
    const request = mock.fn(async (route: string, parameters: Record<string, unknown>) => {
        if (route.startsWith('POST ')) {
            const body = String(parameters.body);
            posts.push(body);
            comments.push({ id: 5000 + comments.length, body, user: { login: 'propr-dev[bot]' } });
            return { data: {} };
        }
        if (route.startsWith('PATCH ')) {
            const comment = comments.find(entry => entry.id === parameters.comment_id);
            if (comment) comment.body = String(parameters.body);
            return { data: {} };
        }
        if (route === 'GET /repos/{owner}/{repo}/actions/jobs/{job_id}') {
            const job = jobs.find(entry => entry.id === parameters.job_id);
            const steps = job?.id === AGGREGATE_ID
                ? aggregateSteps(options.aggregateFailedSteps)
                : [{ name: 'Run Full Test Suite shard', conclusion: 'failure' }];
            return { data: { ...job, run_id: RUN_ID, run_attempt: 1, completed_at: '2026-11-19T06:00:00Z', steps } };
        }
        if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs') {
            return { data: { total_count: jobs.length, jobs: jobs.map(job => ({ ...job, html_url: job.url })) } };
        }
        if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') {
            return { data: { id: RUN_ID, path: WORKFLOW_PATH, head_sha: HEAD } };
        }
        if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
            contentsReads.push(parameters);
            if (options.workflowReadable === false) throw new Error('HTTP 404 Not Found');
            return { data: { encoding: 'base64', content: Buffer.from(WORKFLOW_TEXT).toString('base64') } };
        }
        if (route === 'GET /repos/{owner}/{repo}/check-runs/{check_run_id}') {
            return { data: { details_url: `https://github.com/integry/propr/actions/runs/${RUN_ID}/job/13`, output: { title: 'Shard 3 failed', summary: 'test/foo.test.ts failed', annotations_count: 0 } } };
        }
        if (route.includes('/actions/runs/')) return { data: { status: 'completed', conclusion: 'failure' } };
        throw new Error(`unexpected route ${route}`);
    });
    const octokit = {
        request,
        paginate: mock.fn(async (route: string) => (route.includes('/comments') ? comments.map(comment => ({ ...comment })) : [])),
    };
    return { octokit, comments, posts, contentsReads };
}

function dependencies(octokit: ReturnType<typeof fakeGitHub>['octokit']) {
    const values = new Map<string, string>();
    return {
        isEnabled: async () => true,
        getOctokit: async () => octokit,
        redisClient: {
            get: async (key: string) => values.get(key) ?? null,
            set: async (key: string, value: string, ...args: Array<string | number>) => {
                if (args.includes('NX') && values.has(key)) return null;
                values.set(key, value);
                return 'OK';
            },
            del: async (key: string) => (values.delete(key) ? 1 : 0),
        } as never,
        loadProprCancelledRuns: async () => [],
    };
}

function failure(name: string, jobId: number): CiFailureFollowupRequest {
    return {
        owner: 'integry',
        repo: 'propr',
        prNumber: 3726,
        evidence: {
            kind: 'check_run',
            name,
            state: 'failure',
            sha: HEAD,
            url: `https://github.com/integry/propr/actions/runs/${RUN_ID}/job/${jobId}`,
            source: `check-run:${name}`,
            fallbackExcerpt: `${name} output`,
            checkRunId: jobId,
            annotationsCount: 0,
        },
    };
}

const SHARD = 'Full Test Suite Shard 3/4';

describe('CI-failure comment folds the aggregate under its failed shard', () => {
    test('the shard is the failure and the aggregate is mentioned once, without evidence', async () => {
        const github = fakeGitHub();
        const deps = dependencies(github.octokit);
        await postCiFailureFollowup(failure(SHARD, 13), 'shard', deps);
        github.contentsReads.length = 0;
        const result = await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', deps);

        assert.strictEqual(result.reason, 'updated');
        assert.strictEqual(github.posts.length, 1);
        const body = github.comments[0].body;
        assert.ok(body.startsWith(`CI failed: **${SHARD}**\n`), 'the title lists only the shard');
        assert.ok(body.includes('Please investigate and fix this CI failure.'));
        assert.strictEqual(body.split('**Failure evidence**').length, 2, 'one evidence block');
        assert.ok(!body.includes(`${AGGREGATE} output`));
        assert.ok(body.includes(`Also failed: **${AGGREGATE}**, which only reports the result of the failed job it needs (\`${SHARD}\`)`));
        assert.strictEqual(github.contentsReads.length, 1);
        assert.deepStrictEqual(github.contentsReads[0], { owner: 'integry', repo: 'propr', path: WORKFLOW_PATH, ref: HEAD });

        const redelivered = await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'again', dependencies(github.octokit));
        assert.strictEqual(redelivered.reason, 'duplicate');
    });

    test('an aggregate reported first posts the shard as the failure; the follow-up prompt gets the same folded list', async () => {
        const github = fakeGitHub();
        const deps = dependencies(github.octokit);
        const result = await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', deps);

        assert.strictEqual(result.reason, 'posted');
        const prompt = stripCiFailureFollowupMarker(github.posts[0]);
        assert.ok(prompt.startsWith(`CI failed: **${SHARD}**\n`));
        assert.ok(prompt.includes(`- Check: \`${SHARD}\``));
        assert.ok(prompt.includes('> Shard 3 failed'));
        assert.ok(prompt.includes(`Also failed: **${AGGREGATE}**`));
        assert.ok(!prompt.includes(`- Check: \`${AGGREGATE}\``));
        assert.ok(!prompt.includes('<!--'), 'no hidden markers reach the prompt');

        // The shard's own delivery finds itself already reported.
        const shard = await postCiFailureFollowup(failure(SHARD, 13), 'shard', deps);
        assert.strictEqual(shard.reason, 'duplicate');
        assert.strictEqual(github.posts.length, 1);
    });

    test('an aggregate with its own failed step is listed as a separate failure', async () => {
        const github = fakeGitHub({ aggregateFailedSteps: [COVERAGE, GATE] });
        const deps = dependencies(github.octokit);
        await postCiFailureFollowup(failure(SHARD, 13), 'shard', deps);
        await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', deps);

        const body = github.comments[0].body;
        assert.ok(body.startsWith(`CI failed: **${SHARD}**, **${AGGREGATE}**\n`));
        assert.ok(body.includes(`${AGGREGATE} output`));
        assert.ok(!body.includes('Also failed:'));
    });

    test('an unreadable workflow file lists the aggregate as a separate failure', async () => {
        const github = fakeGitHub({ workflowReadable: false });
        const deps = dependencies(github.octokit);
        await postCiFailureFollowup(failure(SHARD, 13), 'shard', deps);
        await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', deps);

        const body = github.comments[0].body;
        assert.ok(body.startsWith(`CI failed: **${SHARD}**, **${AGGREGATE}**\n`));
        assert.ok(body.includes(`- Check: \`${AGGREGATE}\``));
        assert.ok(!body.includes('Also failed:'));
    });

    test('loadAggregateFold reads the workflow file once per run', async () => {
        const github = fakeGitHub();
        const cache = new Map();
        const log = { debug: () => undefined } as never;
        const target = { owner: 'integry', repo: 'propr', url: failure(AGGREGATE, AGGREGATE_ID).evidence.url, state: 'failure' };
        assert.ok(await loadAggregateFold(github.octokit, target, cache, log));
        assert.ok(await loadAggregateFold(github.octokit, target, cache, log));
        assert.strictEqual(github.contentsReads.length, 1);
    });
});
