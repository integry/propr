import { after, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { classifyCiInfrastructureFailure, type CiInfrastructureEvidence } from '../packages/core/src/webhook/ciFailureInfrastructure.js';
import { postCiFailureFollowup, type CiFailureFollowupRequest } from '../packages/core/src/webhook/ciFailureFollowup.js';
import { resumeDeferredCiInfrastructureRerun, retryPendingCiInfrastructureReruns } from '../packages/core/src/webhook/ciFailureInfrastructureRerun.js';
import { ciInfrastructureNoticeKey, parseCiInfrastructureNotice } from '../packages/core/src/webhook/ciInfrastructureNotice.js';
import {
    CI_INFRASTRUCTURE_PENDING_RERUN_MAX_AGE_MS, CI_INFRASTRUCTURE_PENDING_RERUNS_KEY, CI_INFRASTRUCTURE_PENDING_SCRIPTS,
} from '../packages/core/src/webhook/ciInfrastructureRerunPending.js';

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
    const hashes = new Map<string, Map<string, string>>();
    /** Injected Redis failures: throw from these to fail a write. */
    const faults: { set?: (key: string) => void; eval?: (script: string) => void } = {};
    return {
        values,
        faults,
        get: mock.fn(async (key: string) => values.get(key) ?? null),
        set: mock.fn(async (key: string, value: string, ...args: Array<string | number>) => {
            faults.set?.(key);
            if (args.includes('NX') && values.has(key)) return null;
            values.set(key, value);
            return 'OK';
        }),
        del: mock.fn(async (key: string) => values.delete(key) ? 1 : 0),
        hset: mock.fn(async (key: string, field: string, value: string) => {
            const hash = hashes.get(key) ?? new Map<string, string>();
            hashes.set(key, hash.set(field, value));
            return 1;
        }),
        hget: mock.fn(async (key: string, field: string) => hashes.get(key)?.get(field) ?? null),
        hgetall: mock.fn(async (key: string) => Object.fromEntries(hashes.get(key) ?? [])),
        eval: mock.fn(async (script: string, _keys: number, key: string, ...args: string[]) => {
            faults.eval?.(script);
            if (script === CI_INFRASTRUCTURE_PENDING_SCRIPTS.claimWithIntent) {
                const [hashKey, attempt, , field, raw] = args;
                if (values.has(key)) return 0;
                values.set(key, attempt);
                const hash = hashes.get(hashKey) ?? new Map<string, string>();
                hashes.set(hashKey, hash.set(field, raw));
                return 1;
            }
            if (script === CI_INFRASTRUCTURE_PENDING_SCRIPTS.compareAndDeleteKey) {
                return values.get(key) === args[0] ? (values.delete(key) ? 1 : 0) : 0;
            }
            if (script === CI_INFRASTRUCTURE_PENDING_SCRIPTS.compareAndDeleteField) {
                return hashes.get(key)?.get(args[0]) === args[1] ? (hashes.get(key)!.delete(args[0]) ? 1 : 0) : 0;
            }
            throw new Error('unexpected script');
        }),
        pending: () => [...(hashes.get(CI_INFRASTRUCTURE_PENDING_RERUNS_KEY)?.keys() ?? [])],
    };
}

/** GitHub for the #3703 failure: the job's install step failed with the Chromium timeout. */
function createOctokit(options: {
    runStatus?: string; runAttempt?: number; liveAttempt?: number; rerun?: () => unknown; annotations?: unknown[]; annotationsError?: Error;
    /** Workflow run of a job id; the #3703 run by default. */
    runOfJob?: Record<number, number>;
    pr?: { state: string; head: { sha: string } };
} = {}) {
    const reran: number[] = [];
    const routes: string[] = [];
    const comments: string[] = [];
    const octokit = {
        routes,
        comments,
        reran,
        paginate: mock.fn(async (route: string) => {
            routes.push(route);
            if (route.includes('annotations')) {
                if (options.annotationsError) throw options.annotationsError;
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
                    id: parameters.job_id, run_id: options.runOfJob?.[Number(parameters.job_id)] ?? 44288180457, run_attempt: options.runAttempt ?? 1, conclusion: 'failure', status: 'completed',
                    steps: [
                        { name: 'Set up job', conclusion: 'success' },
                        { name: 'Run ./scripts/ci-install-chromium.sh', conclusion: 'failure' },
                        { name: 'Run npm test', conclusion: 'skipped' },
                    ],
                } };
            }
            if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') return { data: {
                id: parameters.run_id, status: options.runStatus ?? 'completed', ...(options.liveAttempt ? { run_attempt: options.liveAttempt } : {}),
            } };
            if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs') {
                if (options.rerun) return { data: options.rerun() };
                reran.push(Number(parameters.run_id));
                return { data: {} };
            }
            if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: options.pr ?? { state: 'open', head: { sha: SHA } } };
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

describe('test, build and lint steps are never setup steps', () => {
    const network = ['Error: connect ECONNREFUSED 127.0.0.1:8787'];

    test('a network error in a Playwright, browser or mixed install-and-test step stays a code failure', () => {
        for (const step of [
            'Run Playwright tests', 'Run browser tests', 'Install dependencies and run tests', 'Run npx playwright test',
            'Build and install', 'Run chromium smoke', 'Run playwright', 'Typecheck', 'Run npm run check',
        ]) {
            assert.equal(classifyCiInfrastructureFailure(evidence({ texts: network, failedSteps: [step] })).infrastructure, false, step);
        }
    });

    test('a network error in a clear preparation step is still infrastructure', () => {
        for (const step of [
            'Install dependencies', 'Install Playwright browsers', 'Run npx playwright install --with-deps chromium', 'Run npm ci',
            'Set up Node.js', 'Run actions/checkout@v4', 'Restore cache', 'Run apt-get install -y fonts-unifont',
        ]) {
            assert.equal(classifyCiInfrastructureFailure(evidence({ texts: network, failedSteps: [step] })).infrastructure, true, step);
        }
    });
});

describe('unreadable annotations never make a failure infrastructure', () => {
    const shutdown = 'The runner has received a shutdown signal. This can happen when the runner service is stopped.';

    test('the classifier declines when the annotations could not be read', () => {
        assert.equal(classifyCiInfrastructureFailure(evidence({ texts: [shutdown], annotations: undefined, failedSteps: ['Install dependencies'] })).infrastructure, false);
        assert.equal(classifyCiInfrastructureFailure(evidence({ texts: [shutdown], annotations: [], failedSteps: ['Install dependencies'] })).infrastructure, true);
    });

    test('an annotation read failure posts the ordinary follow-up despite runner-problem output', async () => {
        const redis = createRedis();
        const octokit = createOctokit({ annotationsError: Object.assign(new Error('Service Unavailable'), { status: 503 }) });
        const failing = { ...request(), evidence: { ...request().evidence, fallbackExcerpt: shutdown } };
        const result = await postCiFailureFollowup(failing, 'unreadable', { isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never });

        assert.equal(result.reason, 'posted');
        assert.equal(octokit.comments.length, 1);
        assert.equal(octokit.routes.includes(RERUN), false);
        assert.equal(noticeOf(redis), null);
    });
});

describe('deferred re-runs are never stranded', () => {
    const deps = (redis: ReturnType<typeof createRedis>, octokit: ReturnType<typeof createOctokit>, now?: () => number) => ({
        isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never, ...(now ? { now } : {}),
    });

    test('a singleton workflow finishing after its last check event is re-run by the sweep, without another check event', async () => {
        const redis = createRedis();
        const running = createOctokit({ runStatus: 'in_progress' });
        await postCiFailureFollowup(request(), 'infra', deps(redis, running));
        assert.equal(noticeOf(redis)?.action, 'rerun_deferred');

        // Still running at the first sweep: kept.
        assert.equal(await retryPendingCiInfrastructureReruns(deps(redis, running)), 0);
        assert.equal(redis.pending().length, 1);

        const finished = createOctokit();
        assert.equal(await retryPendingCiInfrastructureReruns(deps(redis, finished)), 1);
        assert.deepEqual(finished.reran, [44288180457]);
        assert.equal(noticeOf(redis)?.action, 'rerun_requested');
        assert.deepEqual(redis.pending(), []);

        // Released: a later sweep sends nothing again.
        const idle = createOctokit();
        assert.equal(await retryPendingCiInfrastructureReruns(deps(redis, idle)), 0);
        assert.deepEqual(idle.routes, []);
    });

    test('ordinary failure recovery of the same attempt resumes the deferred re-run instead of reporting it already requested', async () => {
        const redis = createRedis();
        await postCiFailureFollowup(request(), 'infra', deps(redis, createOctokit({ runStatus: 'in_progress' })));
        const finished = createOctokit();
        const recovered = await postCiFailureFollowup(request(), 'ci-recovery-3699', deps(redis, finished));

        assert.deepEqual(recovered, { posted: false, reason: 'infrastructure' });
        assert.deepEqual(finished.reran, [44288180457]);
        assert.deepEqual(finished.comments, []);
        assert.equal(noticeOf(redis)?.action, 'rerun_requested');
        assert.deepEqual(redis.pending(), []);
    });

    test('a run that never finishes is given up on with an actionable notice', async () => {
        const redis = createRedis();
        const running = createOctokit({ runStatus: 'in_progress' });
        await postCiFailureFollowup(request(), 'infra', deps(redis, running));
        const later = Date.now() + CI_INFRASTRUCTURE_PENDING_RERUN_MAX_AGE_MS + 1;
        assert.equal(await retryPendingCiInfrastructureReruns(deps(redis, running, () => later)), 1);
        assert.deepEqual(running.reran, []);
        assert.equal(noticeOf(redis)?.action, 'rerun_unavailable');
        assert.deepEqual(redis.pending(), []);
    });

    test('a pending re-run of an obsolete head is dropped without re-running', async () => {
        const redis = createRedis();
        await postCiFailureFollowup(request(), 'infra', deps(redis, createOctokit({ runStatus: 'in_progress' })));
        const pushed = createOctokit({ pr: { state: 'open', head: { sha: 'f'.repeat(40) } } });
        assert.equal(await retryPendingCiInfrastructureReruns(deps(redis, pushed)), 0);
        assert.deepEqual(pushed.reran, []);
        assert.deepEqual(redis.pending(), []);
    });

    test('two workflow runs deferred on one head each get their single re-run', async () => {
        const redis = createRedis();
        const runOfJob = { 134748686933: 44288180457, 134748699999: 44288189999 };
        const workflowB: CiFailureFollowupRequest = { ...request(), evidence: {
            ...request().evidence, name: 'Desktop acceptance', source: 'check-run:Desktop acceptance', checkRunId: 134748699999,
            url: 'https://github.com/integry/propr/actions/runs/44288189999/job/134748699999',
        } };
        const running = createOctokit({ runStatus: 'in_progress', runOfJob });
        await postCiFailureFollowup(request(), 'infra-a', deps(redis, running));
        await postCiFailureFollowup(workflowB, 'infra-b', deps(redis, running));
        assert.equal(redis.pending().length, 2);
        assert.equal(noticeOf(redis)?.runId, 44288189999, 'the notice is only the latest summary');

        const finished = createOctokit({ runOfJob });
        const target = { owner: 'integry', repo: 'propr', prNumber: 3699, headSha: SHA };
        await resumeDeferredCiInfrastructureRerun(target, 'resume', deps(redis, finished));
        assert.deepEqual([...finished.reran].sort(), [44288180457, 44288189999]);
        assert.deepEqual(redis.pending(), []);

        await resumeDeferredCiInfrastructureRerun(target, 'resume-again', deps(redis, finished));
        await retryPendingCiInfrastructureReruns(deps(redis, finished));
        assert.equal(finished.reran.length, 2, 'each run is re-run exactly once');
    });

    test('a run locked by another resumer is not re-run twice', async () => {
        const redis = createRedis();
        await postCiFailureFollowup(request(), 'infra', deps(redis, createOctokit({ runStatus: 'in_progress' })));
        redis.values.set('propr:ci-infra-rerun-lock:integry/propr:44288180457', 'someone-else');
        const finished = createOctokit();
        assert.equal(await retryPendingCiInfrastructureReruns(deps(redis, finished)), 0);
        assert.deepEqual(finished.reran, []);
        assert.equal(redis.pending().length, 1, 'kept for the lock holder or the next sweep');
    });
});

describe('rerun bookkeeping is reconciled and never changes the verdict', () => {
    const deps = (redis: ReturnType<typeof createRedis>, octokit: ReturnType<typeof createOctokit>) => ({
        isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never,
    });
    const target = { owner: 'integry', repo: 'propr', prNumber: 3699, headSha: SHA };
    /** The next compare-and-delete of a pending entry fails, as if Redis dropped or the process stopped. */
    const failNextRelease = (redis: ReturnType<typeof createRedis>) => {
        redis.faults.eval = script => {
            if (script !== CI_INFRASTRUCTURE_PENDING_SCRIPTS.compareAndDeleteField) return;
            delete redis.faults.eval;
            throw new Error('Connection is closed.');
        };
    };

    test('an accepted re-run whose pending entry could not be released is not sent again by a later sweep', async () => {
        const redis = createRedis();
        await postCiFailureFollowup(request(), 'infra', deps(redis, createOctokit({ runStatus: 'in_progress' })));
        failNextRelease(redis);
        const finished = createOctokit();
        assert.equal(await retryPendingCiInfrastructureReruns(deps(redis, finished)), 0, 'the release failed: kept');
        assert.deepEqual(finished.reran, [44288180457]);
        assert.equal(redis.pending().length, 1, 'the accepted re-run outlived its request');

        // Attempt 2 is running or failed again: neither the sweep, the hook nor recovery re-runs it.
        const advanced = createOctokit({ liveAttempt: 2 });
        assert.equal(await retryPendingCiInfrastructureReruns(deps(redis, advanced)), 1);
        await resumeDeferredCiInfrastructureRerun(target, 'resume', deps(redis, advanced));
        await postCiFailureFollowup(request(), 'ci-recovery-3699', deps(redis, advanced));
        assert.equal(advanced.routes.includes(RERUN), false);
        assert.deepEqual(redis.pending(), []);
        assert.equal(noticeOf(redis)?.action, 'rerun_requested');
    });

    test('recovery of the same attempt settles a re-run already accepted by GitHub without sending it again', async () => {
        const redis = createRedis();
        failNextRelease(redis);
        const first = createOctokit();
        assert.deepEqual(await postCiFailureFollowup(request(), 'infra', deps(redis, first)), { posted: false, reason: 'infrastructure' });
        assert.deepEqual(first.reran, [44288180457]);
        assert.deepEqual(first.comments, []);
        assert.equal(redis.pending().length, 1);

        const recovery = createOctokit({ liveAttempt: 2, runStatus: 'in_progress' });
        assert.deepEqual(await postCiFailureFollowup(request(), 'ci-recovery-3699', deps(redis, recovery)), { posted: false, reason: 'infrastructure' });
        assert.equal(recovery.routes.includes(RERUN), false);
        assert.deepEqual(redis.pending(), []);
        assert.equal(noticeOf(redis)?.action, 'rerun_requested');
    });

    test('a settled stale entry keeps the notice of the later attempt', async () => {
        const redis = createRedis();
        failNextRelease(redis);
        await postCiFailureFollowup(request(), 'infra', deps(redis, createOctokit()));
        // Attempt 2 fails on the runner again: the one re-run is spent.
        await postCiFailureFollowup(request(), 'infra-again', deps(redis, createOctokit({ runAttempt: 2, liveAttempt: 2 })));
        assert.equal(noticeOf(redis)?.action, 'rerun_unavailable');

        const sweep = createOctokit({ liveAttempt: 2 });
        assert.equal(await retryPendingCiInfrastructureReruns(deps(redis, sweep)), 1);
        assert.equal(sweep.routes.includes(RERUN), false);
        assert.deepEqual(redis.pending(), []);
        assert.equal(noticeOf(redis)?.action, 'rerun_unavailable');
        assert.equal(noticeOf(redis)?.runAttempt, 2);
    });

    test('a claim interrupted before GitHub was asked stays recoverable by recovery and the sweep', async () => {
        for (const resume of ['recovery', 'sweep'] as const) {
            const redis = createRedis();
            // The process stops right after the claim: the lock is never taken, GitHub never asked.
            redis.faults.set = key => {
                if (!key.startsWith('propr:ci-infra-rerun-lock:')) return;
                delete redis.faults.set;
                throw new Error('Connection is closed.');
            };
            const interrupted = createOctokit();
            assert.deepEqual(await postCiFailureFollowup(request(), 'infra', deps(redis, interrupted)), { posted: false, reason: 'infrastructure' });
            assert.deepEqual(interrupted.reran, []);
            assert.deepEqual(interrupted.comments, []);
            assert.equal(redis.pending().length, 1, `${resume}: the claim is recorded with its owed re-run`);

            const later = createOctokit();
            if (resume === 'recovery') {
                assert.deepEqual(await postCiFailureFollowup(request(), 'ci-recovery-3699', deps(redis, later)), { posted: false, reason: 'infrastructure' });
            } else {
                assert.equal(await retryPendingCiInfrastructureReruns(deps(redis, later)), 1);
            }
            assert.deepEqual(later.reran, [44288180457], resume);
            assert.deepEqual(later.comments, [], resume);
            assert.equal(noticeOf(redis)?.action, 'rerun_requested', resume);
            assert.deepEqual(redis.pending(), [], resume);
        }
    });

    test('a failed notice or bookkeeping write after the infrastructure verdict posts no code follow-up', async () => {
        const noticeKey = ciInfrastructureNoticeKey('integry/propr', 3699);
        for (const failing of ['notice', 'claim'] as const) {
            const redis = createRedis();
            if (failing === 'notice') {
                redis.faults.set = key => { if (key === noticeKey) throw new Error('OOM command not allowed'); };
            } else {
                redis.faults.eval = script => { if (script === CI_INFRASTRUCTURE_PENDING_SCRIPTS.claimWithIntent) throw new Error('OOM command not allowed'); };
            }
            const octokit = createOctokit();
            const result = await postCiFailureFollowup(request(), 'infra', deps(redis, octokit));
            assert.deepEqual(result, { posted: false, reason: 'infrastructure' }, failing);
            assert.deepEqual(octokit.comments, [], failing);
            assert.equal([...redis.values.keys()].some(key => key.startsWith('ci-failure-followup:')), false, failing);
            assert.equal(octokit.reran.length, failing === 'notice' ? 1 : 0, failing);
        }
    });
});
