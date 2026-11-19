import { after, describe, test, mock } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { closeConnection } from '../packages/core/src/db/connection.js';
import {
    parseWorkflowJobs,
    relateFailedJob,
    type ParsedWorkflow,
    type RunJob,
} from '../packages/core/src/webhook/ciFailureJobDependencies.js';
import {
    buildCiFailureDedupeKey,
    buildCiFailureFollowupMarker,
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
const SHARD = 'Full Test Suite Shard 3/4';
const dependencyLine = (names: string[]) =>
    `Depends on the failed job(s) above: ${names.map(name => `\`${name}\``).join(', ')}. It may have failed only because they did; check them first.`;

function workflow(): ParsedWorkflow {
    const parsed = parseWorkflowJobs(WORKFLOW_TEXT);
    assert.ok(parsed, 'the repository workflow parses');
    return parsed;
}

function runJobs(failedShards: number[], routeFailed = false): RunJob[] {
    return [
        { id: 1, name: 'Classify changed surfaces', conclusion: 'success' },
        { id: 2, name: 'Select PR check runners', conclusion: routeFailed ? 'failure' : 'success' },
        ...[1, 2, 3, 4].map(shard => ({
            id: 10 + shard,
            name: `Full Test Suite Shard ${shard}/4`,
            conclusion: failedShards.includes(shard) ? 'failure' : 'success',
        })),
        { id: 20, name: 'Validate Docs Site', conclusion: 'success' },
        { id: 21, name: 'Full Test Suite Native Electron (hosted)', conclusion: 'skipped' },
        { id: AGGREGATE_ID, name: AGGREGATE, conclusion: 'failure' },
    ];
}

describe('relateFailedJob with the Full Test Suite layout', () => {
    const aggregate = { id: AGGREGATE_ID, name: AGGREGATE };

    test('the aggregate depends on its failed shard', () => {
        assert.deepStrictEqual(relateFailedJob({ failed: aggregate, runJobs: runJobs([3]), workflow: workflow() }), {
            job: AGGREGATE, dependsOn: [SHARD],
        });
    });

    test('several failed shards are all named, in the run order', () => {
        assert.deepStrictEqual(relateFailedJob({ failed: aggregate, runJobs: runJobs([4, 1]), workflow: workflow() })?.dependsOn, [
            'Full Test Suite Shard 1/4', 'Full Test Suite Shard 4/4',
        ]);
    });

    test('an aggregate with no failed needed job has no dependency', () => {
        assert.strictEqual(relateFailedJob({ failed: aggregate, runJobs: runJobs([]), workflow: workflow() }), null);
        // The runner selection failed, but the aggregate does not need it directly.
        assert.strictEqual(relateFailedJob({ failed: aggregate, runJobs: runJobs([], true), workflow: workflow() }), null);
    });

    test('a shard depends only on what it needs directly', () => {
        const shard = { id: 13, name: SHARD };
        assert.strictEqual(relateFailedJob({ failed: shard, runJobs: runJobs([3]), workflow: workflow() }), null);
        assert.deepStrictEqual(relateFailedJob({ failed: shard, runJobs: runJobs([3], true), workflow: workflow() })?.dependsOn, [
            'Select PR check runners',
        ]);
    });

    test('a job name that maps to more than one job id has no dependency', () => {
        const ambiguous = parseWorkflowJobs(`${WORKFLOW_TEXT}\n  other:\n    name: Run Full Test Suite\n    needs: shard\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo\n`);
        assert.ok(ambiguous);
        assert.strictEqual(relateFailedJob({ failed: aggregate, runJobs: runJobs([3]), workflow: ambiguous }), null);
    });

    const matrixWorkflow = (extraJob: string[] = []) => parseWorkflowJobs([
        'jobs:',
        '  build:',
        '    strategy:',
        '      matrix:',
        '        os: [linux, mac]',
        '    steps: [{ run: make }]',
        ...extraJob,
        '  gate:',
        '    needs: [build]',
        '    steps: [{ run: exit 1 }]',
    ].join('\n')) as ParsedWorkflow;
    const matrixRun = (buildName: string): RunJob[] => [
        { id: 1, name: buildName, conclusion: 'failure' },
        { id: 2, name: 'build (mac)', conclusion: 'success' },
        { id: 3, name: 'gate', conclusion: 'failure' },
    ];

    test('matrix jobs without a templated name map through their appended values', () => {
        assert.deepStrictEqual(relateFailedJob({ failed: { id: 3, name: 'gate' }, runJobs: matrixRun('build (linux)'), workflow: matrixWorkflow() })?.dependsOn, [
            'build (linux)',
        ]);
    });

    test('a failed matrix job whose name also fits another job id gives no dependency', () => {
        const parsed = matrixWorkflow(['  other:', '    name: build (linux)', '    steps: [{ run: make }]']);
        assert.strictEqual(relateFailedJob({ failed: { id: 3, name: 'gate' }, runJobs: matrixRun('build (linux)'), workflow: parsed }), null);
    });

    test('a failed job that maps to no job id gives no dependency', () => {
        assert.strictEqual(relateFailedJob({ failed: { id: 3, name: 'gate' }, runJobs: matrixRun('renamed (linux)'), workflow: matrixWorkflow() }), null);
    });

    test('an unparsable workflow file is not read', () => {
        assert.strictEqual(parseWorkflowJobs('jobs: [unclosed'), null);
        assert.strictEqual(parseWorkflowJobs('jobs:\n  test:\n    needs: { a: 1 }\n'), null);
        assert.strictEqual(parseWorkflowJobs('name: no jobs\n'), null);
    });
});

function fakeGitHub(options: {
    /** `missing`: the contents read fails; `garbage`: the file does not parse. */
    workflowFile?: 'ok' | 'missing' | 'garbage';
    failedShards?: number[];
    routeFailed?: boolean;
} = {}) {
    const comments: Array<{ id: number; body: string; user: { login: string } }> = [];
    const posts: string[] = [];
    const jobs = runJobs(options.failedShards ?? [3], options.routeFailed);
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
            return { data: { ...job, run_id: RUN_ID, run_attempt: 1, steps: [{ name: 'Run', conclusion: 'failure' }] } };
        }
        if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs') {
            return { data: { total_count: jobs.length, jobs } };
        }
        if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') {
            return { data: { id: RUN_ID, path: WORKFLOW_PATH, head_sha: HEAD, status: 'completed', conclusion: 'failure' } };
        }
        if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
            contentsReads.push(parameters);
            if (options.workflowFile === 'missing') throw new Error('HTTP 404 Not Found');
            const text = options.workflowFile === 'garbage' ? 'jobs: [unclosed' : WORKFLOW_TEXT;
            return { data: { encoding: 'base64', content: Buffer.from(text).toString('base64') } };
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

function dependencies(octokit: ReturnType<typeof fakeGitHub>['octokit'], nonBlockingChecks: string[] = []) {
    const values = new Map<string, string>();
    return {
        isEnabled: async () => true,
        loadNonBlockingChecks: async () => nonBlockingChecks,
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

const keyMarker = (request: CiFailureFollowupRequest) => buildCiFailureFollowupMarker(buildCiFailureDedupeKey(request));
const sectionAt = (body: string, name: string) => body.indexOf(`- Check: \`${name}\``);

describe('CI-failure comment relates the aggregate to its failed shard', () => {
    test('shard, then aggregate: both listed with evidence, the aggregate after the shard with the dependency line', async () => {
        const github = fakeGitHub();
        const deps = dependencies(github.octokit);
        assert.strictEqual((await postCiFailureFollowup(failure(SHARD, 13), 'shard', deps)).reason, 'posted');
        assert.ok(!github.posts[0].includes('Depends on'), 'the shard needs no failed job');
        github.contentsReads.length = 0;
        const result = await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', deps);

        assert.strictEqual(result.reason, 'updated');
        assert.strictEqual(github.posts.length, 1);
        const body = github.comments[0].body;
        assert.ok(body.startsWith(`CI failed: **${SHARD}**, **${AGGREGATE}**\n`));
        assert.ok(body.includes('Please investigate and fix these CI failures.'));
        assert.strictEqual(body.split('**Failure evidence**').length, 3, 'each check keeps its own evidence');
        assert.ok(body.includes(`> ${SHARD} output`));
        assert.ok(body.includes(`> ${AGGREGATE} output`));
        assert.ok(sectionAt(body, SHARD) < sectionAt(body, AGGREGATE));
        assert.ok(body.indexOf(dependencyLine([SHARD])) > sectionAt(body, AGGREGATE), 'the line is in the aggregate\'s section');
        assert.strictEqual(body.split('Depends on').length, 2, 'one line');
        assert.ok(body.includes(keyMarker(failure(SHARD, 13))));
        assert.ok(body.includes(keyMarker(failure(AGGREGATE, AGGREGATE_ID))));
        assert.strictEqual(github.contentsReads.length, 1);
        assert.deepStrictEqual(github.contentsReads[0], { owner: 'integry', repo: 'propr', path: WORKFLOW_PATH, ref: HEAD });

        assert.strictEqual((await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'again', dependencies(github.octokit))).reason, 'duplicate');
    });

    test('aggregate first: the follow-up prompt has the line; the shard is then listed before the aggregate', async () => {
        const github = fakeGitHub();
        const deps = dependencies(github.octokit);
        assert.strictEqual((await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', deps)).reason, 'posted');
        const prompt = stripCiFailureFollowupMarker(github.posts[0]);
        assert.ok(prompt.startsWith(`CI failed: **${AGGREGATE}**\n`));
        assert.ok(prompt.includes(`> ${AGGREGATE} output`), 'the aggregate keeps its evidence');
        assert.ok(prompt.includes(dependencyLine([SHARD])));
        assert.ok(!prompt.includes('<!--'), 'no hidden markers reach the prompt');

        assert.strictEqual((await postCiFailureFollowup(failure(SHARD, 13), 'shard', deps)).reason, 'updated');
        const body = github.comments[0].body;
        assert.ok(body.startsWith(`CI failed: **${SHARD}**, **${AGGREGATE}**\n`), 'the shard comes first in the title');
        assert.ok(sectionAt(body, SHARD) < sectionAt(body, AGGREGATE), 'and in the sections');
        const lines = body.split('\n');
        const shardAt = lines.indexOf(`- Check: \`${SHARD}\``);
        assert.ok(lines[shardAt + 2].startsWith('- Commit: '), 'the commit line moves to the first check');
        assert.strictEqual(body.split('- Commit: ').length, 2);
        assert.strictEqual(body.split('**Failure evidence**').length, 3);
        assert.ok(body.includes(keyMarker(failure(SHARD, 13))));
        assert.ok(body.includes(keyMarker(failure(AGGREGATE, AGGREGATE_ID))));
    });

    test('a shard joining a comment started by another failure goes before its dependent aggregate only', async () => {
        const github = fakeGitHub({ failedShards: [1, 3] });
        const deps = dependencies(github.octokit);
        await postCiFailureFollowup(failure('Lint', 30), 'lint', deps);
        await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', deps);
        await postCiFailureFollowup(failure(SHARD, 13), 'shard', deps);
        await postCiFailureFollowup(failure('Full Test Suite Shard 1/4', 11), 'shard-1', deps);

        const body = github.comments[0].body;
        assert.ok(body.startsWith(`CI failed: **Lint**, **${SHARD}**, **Full Test Suite Shard 1/4**, **${AGGREGATE}**\n`));
        assert.ok(sectionAt(body, 'Lint') < sectionAt(body, SHARD));
        assert.ok(sectionAt(body, 'Full Test Suite Shard 1/4') < sectionAt(body, AGGREGATE));
        assert.ok(body.includes(dependencyLine(['Full Test Suite Shard 1/4', SHARD])));
        assert.strictEqual(body.split('**Failure evidence**').length, 5);
    });

    test('a chain arriving aggregate, runner selection, shard is listed runner selection, shard, aggregate', async () => {
        const ROUTE = 'Select PR check runners';
        const github = fakeGitHub({ failedShards: [3], routeFailed: true });
        const deps = dependencies(github.octokit);
        assert.strictEqual((await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', deps)).reason, 'posted');
        assert.ok(github.posts[0].includes(dependencyLine([SHARD])), 'the aggregate names only the job it needs directly');
        assert.strictEqual((await postCiFailureFollowup(failure(ROUTE, 2), 'route', deps)).reason, 'updated');
        assert.strictEqual((await postCiFailureFollowup(failure(SHARD, 13), 'shard', deps)).reason, 'updated');

        assert.strictEqual(github.posts.length, 1);
        const body = github.comments[0].body;
        assert.ok(body.startsWith(`CI failed: **${ROUTE}**, **${SHARD}**, **${AGGREGATE}**\n`), body.split('\n')[0]);
        assert.ok(sectionAt(body, ROUTE) < sectionAt(body, SHARD));
        assert.ok(sectionAt(body, SHARD) < sectionAt(body, AGGREGATE));
        const lines = body.split('\n');
        assert.ok(lines[lines.indexOf(`- Check: \`${ROUTE}\``) + 2].startsWith('- Commit: '), 'the commit line follows the first check');
        assert.strictEqual(body.split('- Commit: ').length, 2);
        const shardLine = body.indexOf(dependencyLine([ROUTE]));
        assert.ok(shardLine > sectionAt(body, SHARD) && shardLine < sectionAt(body, AGGREGATE), 'the shard keeps its line');
        const aggregateLine = body.indexOf(dependencyLine([SHARD]));
        assert.ok(aggregateLine > sectionAt(body, AGGREGATE), 'the aggregate keeps its line');
        assert.strictEqual(body.split('Depends on').length, 3);
        assert.strictEqual(body.split('**Failure evidence**').length, 4);
        for (const name of [ROUTE, SHARD, AGGREGATE]) assert.ok(body.includes(`> ${name} output`), `${name} keeps its evidence`);
        assert.ok(body.includes(keyMarker(failure(AGGREGATE, AGGREGATE_ID))));
        assert.ok(body.includes(keyMarker(failure(ROUTE, 2))));
        assert.ok(body.includes(keyMarker(failure(SHARD, 13))));
    });

    test('an aggregate failing with no failed needed job gets no line', async () => {
        const github = fakeGitHub({ failedShards: [], routeFailed: true });
        await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', dependencies(github.octokit));
        assert.ok(github.posts[0].includes(`- Check: \`${AGGREGATE}\``));
        assert.ok(!github.posts[0].includes('Depends on'));

        // Nothing else failed: the workflow file is not read at all.
        const alone = fakeGitHub({ failedShards: [] });
        await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', dependencies(alone.octokit));
        assert.ok(!alone.posts[0].includes('Depends on'));
        assert.strictEqual(alone.contentsReads.length, 0);
    });

    for (const workflowFile of ['missing', 'garbage'] as const) {
        test(`a ${workflowFile === 'missing' ? 'unreadable' : 'unparsable'} workflow file adds no line and keeps the arrival order`, async () => {
            const github = fakeGitHub({ workflowFile });
            const deps = dependencies(github.octokit);
            await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', deps);
            await postCiFailureFollowup(failure(SHARD, 13), 'shard', deps);

            const body = github.comments[0].body;
            assert.strictEqual(github.contentsReads.length > 0, true);
            assert.ok(body.startsWith(`CI failed: **${AGGREGATE}**, **${SHARD}**\n`));
            assert.ok(sectionAt(body, AGGREGATE) < sectionAt(body, SHARD));
            assert.ok(!body.includes('Depends on'));
            assert.strictEqual(body.split('**Failure evidence**').length, 3);
        });
    }
});

describe('a non-blocking failed shard is not named', () => {
    test('the only failed needed job is non-blocking: the blocking aggregate is reported without a line', async () => {
        const github = fakeGitHub();
        const result = await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', dependencies(github.octokit, ['Full Test Suite Shard *']));

        assert.strictEqual(result.reason, 'posted');
        assert.ok(github.posts[0].startsWith(`CI failed: **${AGGREGATE}**\n`));
        assert.ok(github.posts[0].includes(`> ${AGGREGATE} output`));
        assert.ok(!github.posts[0].includes(SHARD), 'the non-blocking shard is not named');
        assert.ok(!github.posts[0].includes('Depends on'));
    });

    test('only the blocking failed shards are named', async () => {
        const github = fakeGitHub({ failedShards: [1, 3] });
        await postCiFailureFollowup(failure(AGGREGATE, AGGREGATE_ID), 'aggregate', dependencies(github.octokit, ['Full Test Suite Shard 1/4']));
        assert.ok(github.posts[0].includes(dependencyLine([SHARD])));
        assert.ok(!github.posts[0].includes('Shard 1/4'));
    });
});
