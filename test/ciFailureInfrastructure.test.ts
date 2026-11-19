import { after, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { classifyCiInfrastructureFailure, type CiInfrastructureEvidence } from '../packages/core/src/webhook/ciFailureInfrastructure.js';
import { postCiFailureFollowup, type CiFailureFollowupRequest } from '../packages/core/src/webhook/ciFailureFollowup.js';
import { resumeDeferredCiInfrastructureRerun } from '../packages/core/src/webhook/ciFailureInfrastructureRerun.js';
import { ciInfrastructureNoticeKey, parseCiInfrastructureNotice } from '../packages/core/src/webhook/ciInfrastructureNotice.js';

after(async () => {
    await closeConnection();
});

const EXIT = { annotation_level: 'failure', path: '.github', message: 'Process completed with exit code 1.' };

function evidence(overrides: Partial<CiInfrastructureEvidence>): CiInfrastructureEvidence {
    return { kind: 'check_run', state: 'failure', texts: [], annotations: [EXIT], failedSteps: null, ...overrides };
}

describe('infrastructure-only CI failure classifier', () => {
    test('the stalled apt mirror of #3703 (Chromium install timed out) is infrastructure', () => {
        const verdict = classifyCiInfrastructureFailure(evidence({
            annotations: [{ annotation_level: 'failure', path: '.github', message: 'Chromium install timed out on every attempt.' }, EXIT],
            failedSteps: ['Run ./scripts/ci-install-chromium.sh'],
        }));
        assert.deepEqual(verdict, { infrastructure: true, cause: 'network', step: 'Run ./scripts/ci-install-chromium.sh' });
    });

    test('an apt fetch failure from the mirror is infrastructure', () => {
        const verdict = classifyCiInfrastructureFailure(evidence({
            texts: ['E: Failed to fetch http://us-east-2.ec2.archive.ubuntu.com/ubuntu/pool/universe/f/fonts-unifont.deb  Connection timed out'],
            failedSteps: ['Install system dependencies'],
        }));
        assert.equal(verdict.infrastructure, true);
    });

    test('a runner shutdown or lost communication is infrastructure whatever step was running', () => {
        for (const message of [
            'The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.',
            "The self-hosted runner: ci-runner-3 lost communication with the server. Verify the machine is running and has a healthy network connection.",
        ]) {
            const verdict = classifyCiInfrastructureFailure(evidence({ annotations: [{ annotation_level: 'failure', message }], failedSteps: ['Run npm test'] }));
            assert.deepEqual(verdict, { infrastructure: true, cause: 'runner_lost' }, message);
        }
    });

    test('a registry 5xx during install is infrastructure', () => {
        for (const message of [
            'npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/typescript',
            'Error response from daemon: received unexpected HTTP status: 502 Bad Gateway',
        ]) {
            const verdict = classifyCiInfrastructureFailure(evidence({ texts: [message], failedSteps: ['Install dependencies'] }));
            assert.equal(verdict.infrastructure, true, message);
        }
    });

    test('a failing test is not infrastructure', () => {
        assert.equal(classifyCiInfrastructureFailure(evidence({
            annotations: [{ annotation_level: 'failure', path: 'test/worker.test.ts', start_line: 12, message: 'AssertionError: expected 2 jobs but received 1' }, EXIT],
            failedSteps: ['Run npm test'],
        })).infrastructure, false);
        // Even with a network error in the output, a test step that failed is the code's.
        assert.equal(classifyCiInfrastructureFailure(evidence({
            texts: ['✖ fetches the catalog\n  Error: connect ECONNREFUSED 127.0.0.1:8787\n1 failing'],
            failedSteps: ['Run npm test'],
        })).infrastructure, false);
        assert.equal(classifyCiInfrastructureFailure(evidence({
            texts: ['connect ETIMEDOUT 10.0.0.5:5432'],
            failedSteps: ['Run integration tests'],
        })).infrastructure, false);
    });

    test('a type error is not infrastructure', () => {
        assert.equal(classifyCiInfrastructureFailure(evidence({
            texts: ["src/index.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'."],
            failedSteps: ['Install dependencies'],
        })).infrastructure, false);
    });

    test('a lint error is not infrastructure', () => {
        assert.equal(classifyCiInfrastructureFailure(evidence({
            texts: ['/src/app.ts\n  3:1  error  Unexpected var  no-var\n\n✖ 1 problem (1 error, 0 warnings)'],
            failedSteps: ['Run npm run lint'],
        })).infrastructure, false);
    });

    test('in doubt it is a code failure: unknown steps, no network evidence, other conclusions', () => {
        const network = ['npm error code ECONNRESET'];
        assert.equal(classifyCiInfrastructureFailure(evidence({ texts: network, failedSteps: null })).infrastructure, false);
        assert.equal(classifyCiInfrastructureFailure(evidence({ texts: network, failedSteps: [] })).infrastructure, false);
        assert.equal(classifyCiInfrastructureFailure(evidence({ texts: network, failedSteps: ['Install dependencies', 'Run build'] })).infrastructure, false);
        assert.equal(classifyCiInfrastructureFailure(evidence({ failedSteps: ['Install dependencies'] })).infrastructure, false);
        assert.equal(classifyCiInfrastructureFailure(evidence({ texts: network, failedSteps: ['Install dependencies'], state: 'startup_failure' })).infrastructure, false);
        assert.equal(classifyCiInfrastructureFailure(evidence({ texts: network, failedSteps: ['Install dependencies'], kind: 'status' })).infrastructure, false);
    });
});

const SHA = '0123456789abcdef0123456789abcdef01234567';

function request(): CiFailureFollowupRequest {
    return {
        owner: 'integry', repo: 'propr', prNumber: 3699,
        evidence: {
            kind: 'check_run', name: 'Validate Changes', state: 'failure', sha: SHA,
            url: 'https://github.com/integry/propr/actions/runs/44288180457/job/134748686933',
            source: 'check-run:Validate Changes', checkRunId: 134748686933, annotationsCount: 2,
        },
    };
}

function createRedis() {
    const values = new Map<string, string>();
    return {
        values,
        get: mock.fn(async (key: string) => values.get(key) ?? null),
        set: mock.fn(async (key: string, value: string, ...args: Array<string | number>) => {
            if (args.includes('NX') && values.has(key)) return null;
            values.set(key, value);
            return 'OK';
        }),
        del: mock.fn(async (key: string) => values.delete(key) ? 1 : 0),
    };
}

/** GitHub for the #3703 failure: the job's install step failed with the Chromium timeout. */
function createOctokit(options: { runStatus?: string; runAttempt?: number; rerun?: () => unknown; annotations?: unknown[] } = {}) {
    const routes: string[] = [];
    const comments: string[] = [];
    const octokit = {
        routes,
        comments,
        paginate: mock.fn(async (route: string) => {
            routes.push(route);
            if (route.includes('annotations')) {
                return options.annotations ?? [
                    { annotation_level: 'failure', path: '.github', message: 'Chromium install timed out on every attempt.' },
                    { annotation_level: 'failure', path: '.github', message: 'Process completed with exit code 1.' },
                ];
            }
            return [];
        }),
        request: mock.fn(async (route: string, parameters: Record<string, unknown>) => {
            routes.push(route);
            if (route === 'GET /repos/{owner}/{repo}/actions/jobs/{job_id}') {
                return { data: {
                    id: parameters.job_id, run_id: 44288180457, run_attempt: options.runAttempt ?? 1, conclusion: 'failure', status: 'completed',
                    steps: [
                        { name: 'Set up job', conclusion: 'success' },
                        { name: 'Run ./scripts/ci-install-chromium.sh', conclusion: 'failure' },
                        { name: 'Run npm test', conclusion: 'skipped' },
                    ],
                } };
            }
            if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') return { data: { id: 44288180457, status: options.runStatus ?? 'completed' } };
            if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs') return { data: options.rerun ? options.rerun() : {} };
            if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') comments.push(String(parameters.body));
            return { data: {} };
        }),
    };
    return octokit;
}

function noticeOf(redis: ReturnType<typeof createRedis>) {
    return parseCiInfrastructureNotice(redis.values.get(ciInfrastructureNoticeKey('integry/propr', 3699)));
}

const RERUN = 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs';

describe('infrastructure-only failure handling', () => {
    test('re-runs the failed jobs once and posts no follow-up comment, so no follow-up starts and no suspension is recorded', async () => {
        const octokit = createOctokit();
        const redis = createRedis();
        // A follow-up — and the suspension its implementation records — only ever starts from a posted CI-failure comment.
        const loadProprCancelledRuns = mock.fn(async () => []);
        const result = await postCiFailureFollowup(request(), 'infra', {
            isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never, loadProprCancelledRuns,
        });

        assert.deepEqual(result, { posted: false, reason: 'infrastructure' });
        assert.deepEqual(octokit.comments, []);
        assert.equal(octokit.routes.filter(route => route === RERUN).length, 1);
        assert.equal(octokit.routes.some(route => route.startsWith('PATCH ')), false);
        // Nothing is claimed for the check: a genuine failure of the re-run still gets its follow-up.
        assert.equal([...redis.values.keys()].some(key => key.startsWith('ci-failure-followup:')), false);
        assert.deepEqual({ ...noticeOf(redis), at: 0 }, {
            headSha: SHA, job: 'Validate Changes', runId: 44288180457, runAttempt: 1, action: 'rerun_requested', at: 0,
        });

        // Another job of the same attempt finds the one re-run already taken.
        const again = await postCiFailureFollowup({ ...request(), evidence: { ...request().evidence, source: 'check-run:Other' } }, 'infra-2', {
            isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never, loadProprCancelledRuns,
        });
        assert.deepEqual(again, { posted: false, reason: 'infrastructure' });
        assert.equal(octokit.routes.filter(route => route === RERUN).length, 1);
    });

    test('the re-run failing on the runner again is not re-run twice: the PR names the job as a runner problem', async () => {
        const redis = createRedis();
        const first = createOctokit();
        await postCiFailureFollowup(request(), 'infra', { isEnabled: async () => true, getOctokit: async () => first, redisClient: redis as never });
        const second = createOctokit({ runAttempt: 2 });
        const result = await postCiFailureFollowup(request(), 'infra-again', { isEnabled: async () => true, getOctokit: async () => second, redisClient: redis as never });

        assert.deepEqual(result, { posted: false, reason: 'infrastructure' });
        assert.equal(second.routes.includes(RERUN), false);
        assert.deepEqual(second.comments, []);
        assert.equal(noticeOf(redis)?.action, 'rerun_unavailable');
    });

    test('a refused re-run is reported on the PR as a runner problem', async () => {
        const redis = createRedis();
        const octokit = createOctokit({ rerun: () => { throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 }); } });
        const result = await postCiFailureFollowup(request(), 'infra', { isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never });
        assert.deepEqual(result, { posted: false, reason: 'infrastructure' });
        assert.deepEqual(octokit.comments, []);
        assert.equal(noticeOf(redis)?.action, 'rerun_unavailable');
    });

    test('a run still running defers the re-run to the next completed check of the head', async () => {
        const redis = createRedis();
        const running = createOctokit({ runStatus: 'in_progress' });
        await postCiFailureFollowup(request(), 'infra', { isEnabled: async () => true, getOctokit: async () => running, redisClient: redis as never });
        assert.equal(running.routes.includes(RERUN), false);
        assert.equal(noticeOf(redis)?.action, 'rerun_deferred');

        const target = { owner: 'integry', repo: 'propr', prNumber: 3699, headSha: SHA };
        await resumeDeferredCiInfrastructureRerun(target, 'resume', { isEnabled: async () => true, getOctokit: async () => running, redisClient: redis as never });
        assert.equal(noticeOf(redis)?.action, 'rerun_deferred', 'still running: still deferred');

        const finished = createOctokit();
        await resumeDeferredCiInfrastructureRerun(target, 'resume', { isEnabled: async () => true, getOctokit: async () => finished, redisClient: redis as never });
        assert.equal(finished.routes.filter(route => route === RERUN).length, 1);
        assert.equal(noticeOf(redis)?.action, 'rerun_requested');

        // Nothing waits any more: GitHub is not read again.
        const idle = createOctokit();
        await resumeDeferredCiInfrastructureRerun(target, 'resume', { isEnabled: async () => true, getOctokit: async () => idle, redisClient: redis as never });
        assert.deepEqual(idle.routes, []);
    });

    test('a code failure next to the network error still posts the follow-up', async () => {
        const redis = createRedis();
        const octokit = createOctokit({ annotations: [
            { annotation_level: 'failure', path: 'test/catalog.test.ts', start_line: 4, message: 'Error: connect ECONNREFUSED 127.0.0.1:8787' },
        ] });
        const result = await postCiFailureFollowup(request(), 'code', { isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never });
        assert.equal(result.reason, 'posted');
        assert.equal(octokit.comments.length, 1);
        assert.equal(octokit.routes.includes(RERUN), false);
        assert.equal(noticeOf(redis), null);
    });
});
