import { after, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { classifyCiInfrastructureFailure, isSetupStep, type CiInfrastructureEvidence } from '../packages/core/src/webhook/ciFailureInfrastructure.js';
import { postCiFailureFollowup, type CiFailureFollowupRequest } from '../packages/core/src/webhook/ciFailureFollowup.js';
import { setPullRequestStatusSyncRunner } from '../packages/core/src/services/pullRequestStatus/pullRequestStatusSignal.js';

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

    test('a runner shutdown or lost communication is infrastructure whatever step it interrupted', () => {
        for (const message of [
            'The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.',
            "The self-hosted runner: ci-runner-3 lost communication with the server. Verify the machine is running and has a healthy network connection.",
        ]) {
            for (const steps of [
                // The interrupted test step is the last that ran: later steps never started.
                [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, { name: 'Run npm test', status: 'completed', conclusion: 'failure' },
                    { name: 'Post Run actions/checkout@v4', status: 'queued', conclusion: null }],
                // The interrupted step was cancelled rather than failed: no step failed.
                [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, { name: 'Run npm test', status: 'completed', conclusion: 'cancelled' }],
                [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, { name: 'Run npm test', status: 'in_progress', conclusion: null }],
            ]) {
                const verdict = classifyCiInfrastructureFailure(evidence({ annotations: [{ annotation_level: 'failure', message }], steps }));
                assert.deepEqual(verdict, { infrastructure: true, cause: 'runner_lost' }, message);
            }
        }
    });

    test('a test step that failed before the runner was lost in a later step stays a code failure', () => {
        const lost = { annotation_level: 'failure', message: 'The self-hosted runner: ci-runner-3 lost communication with the server.' };
        const testFailed = [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, { name: 'Run npm test', status: 'completed', conclusion: 'failure' }];
        for (const cleanup of [
            { name: 'Upload test logs', status: 'completed', conclusion: 'failure' },
            { name: 'Upload test logs', status: 'completed', conclusion: 'cancelled' },
            { name: 'Upload test logs', status: 'in_progress', conclusion: null },
            { name: 'Upload test logs', status: 'completed', conclusion: 'success' },
            { name: 'Upload test logs' },
        ]) {
            const verdict = classifyCiInfrastructureFailure(evidence({ annotations: [EXIT, lost], steps: [...testFailed, cleanup] }));
            assert.equal(verdict.infrastructure, false, JSON.stringify(cleanup));
        }
        // Steps skipped after the failure do not separate the failed step from the runner loss.
        assert.equal(classifyCiInfrastructureFailure(evidence({ annotations: [EXIT, lost], steps: [
            ...testFailed, { name: 'Run npm run build', status: 'completed', conclusion: 'skipped' },
        ] })).infrastructure, true);
    });

    test('a runner loss with unread job steps stays a code failure', () => {
        const lost = { annotation_level: 'failure', message: 'The runner has received a shutdown signal.' };
        assert.equal(classifyCiInfrastructureFailure(evidence({ annotations: [lost], steps: null, failedSteps: ['Run npm test'] })).infrastructure, false);
        assert.equal(classifyCiInfrastructureFailure(evidence({ annotations: [lost] })).infrastructure, false);
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

    test('two failed setup steps with different causes stay a code failure', () => {
        // `npm ci` fails on a lockfile mismatch (no source path, no code-failure wording); an `always()` browser install then hits ECONNRESET.
        const lockfile = { annotation_level: 'failure', path: '.github', message: 'npm ci can only install packages when your package.json and package-lock.json are in sync. Missing: left-pad@1.3.0 from lock file' };
        const reset = { annotation_level: 'failure', path: '.github', message: 'Error: read ECONNRESET while downloading Chromium' };
        const annotations = [lockfile, EXIT, reset, EXIT];
        assert.equal(classifyCiInfrastructureFailure(evidence({ annotations, failedSteps: ['Install dependencies', 'Install browsers'] })).infrastructure, false);
        const steps = [
            { name: 'Set up job', status: 'completed', conclusion: 'success' },
            { name: 'Install dependencies', status: 'completed', conclusion: 'failure' },
            { name: 'Install browsers', status: 'completed', conclusion: 'failure' },
            { name: 'Run npm test', status: 'completed', conclusion: 'skipped' },
        ];
        assert.equal(classifyCiInfrastructureFailure(evidence({ annotations, failedSteps: undefined, steps })).infrastructure, false);
        // Even with the network error as the only evidence, two failed steps cannot both be attributed to it.
        assert.equal(classifyCiInfrastructureFailure(evidence({ annotations: [reset, EXIT], failedSteps: ['Install dependencies', 'Install browsers'] })).infrastructure, false);
        // The single network-failed install step alone is still infrastructure.
        assert.deepEqual(classifyCiInfrastructureFailure(evidence({ annotations: [reset, EXIT], failedSteps: ['Install browsers'] })),
            { infrastructure: true, cause: 'network', step: 'Install browsers' });
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

function createRedis(faults: { set?: () => void } = {}) {
    const values = new Map<string, string>();
    return {
        values,
        get: mock.fn(async (key: string) => values.get(key) ?? null),
        set: mock.fn(async (key: string, value: string, ...args: Array<string | number>) => {
            faults.set?.();
            if (args.includes('NX') && values.has(key)) return null;
            values.set(key, value);
            return 'OK';
        }),
        del: mock.fn(async (key: string) => values.delete(key) ? 1 : 0),
    };
}

/** GitHub for the #3703 failure: the job's install step failed with the Chromium timeout. */
function createOctokit(options: { annotations?: unknown[]; annotationsError?: Error; jobError?: Error; steps?: unknown[] } = {}) {
    const routes: string[] = [];
    const comments: string[] = [];
    const octokit = {
        routes,
        comments,
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
                if (options.jobError) throw options.jobError;
                return { data: {
                    id: parameters.job_id, run_id: 44288180457, run_attempt: 1, conclusion: 'failure', status: 'completed',
                    steps: options.steps ?? [
                        { name: 'Set up job', conclusion: 'success' },
                        { name: 'Run ./scripts/ci-install-chromium.sh', conclusion: 'failure' },
                        { name: 'Run npm test', conclusion: 'skipped' },
                    ],
                } };
            }
            if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') comments.push(String(parameters.body));
            return { data: {} };
        }),
    };
    return octokit;
}

/** Any GitHub Actions re-run request: ProPR never re-runs a runner-problem failure itself. */
const isRerunRoute = (route: string) => /\/actions\/(?:runs|jobs)\/\{[a-z_]+\}\/rerun/.test(route);

describe('infrastructure-only failure handling', () => {
    test('enqueues no follow-up, records no suspension and makes no re-run request', async () => {
        const octokit = createOctokit();
        const redis = createRedis();
        const signalled: Array<[string, number]> = [];
        setPullRequestStatusSyncRunner((repository, prNumber) => { signalled.push([repository, prNumber]); });
        try {
            // A follow-up — and the suspension its implementation records — only ever starts from a posted CI-failure comment.
            const result = await postCiFailureFollowup(request(), 'infra', {
                isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never, loadProprCancelledRuns: async () => [],
            });

            assert.deepEqual(result, { posted: false, reason: 'infrastructure' });
            assert.deepEqual(octokit.comments, []);
            assert.equal(octokit.routes.some(route => route.startsWith('POST ') || route.startsWith('PATCH ')), false);
            assert.equal(octokit.routes.some(isRerunRoute), false);
            // Nothing is claimed or stored for the check: a genuine failure on a manual re-run still gets its follow-up.
            assert.equal(redis.set.mock.callCount(), 0);
            assert.deepEqual([...redis.values.keys()], []);
            // The status block is refreshed; it derives the runner-problem text from the head's checks.
            assert.deepEqual(signalled, [['integry/propr', 3699]]);
        } finally {
            setPullRequestStatusSyncRunner(null);
        }

        // Another job failing the same way is handled the same way: still no comment, no re-run.
        const again = await postCiFailureFollowup({ ...request(), evidence: { ...request().evidence, source: 'check-run:Other' } }, 'infra-2', {
            isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never, loadProprCancelledRuns: async () => [],
        });
        assert.deepEqual(again, { posted: false, reason: 'infrastructure' });
        assert.deepEqual(octokit.comments, []);
        assert.equal(octokit.routes.some(isRerunRoute), false);
    });

    test('a failed status update after the infrastructure verdict is only logged: no code follow-up', async () => {
        const octokit = createOctokit();
        const redis = createRedis();
        setPullRequestStatusSyncRunner(() => { throw new Error('status sync down'); });
        try {
            const result = await postCiFailureFollowup(request(), 'infra-status-down', {
                isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never, loadProprCancelledRuns: async () => [],
            });
            assert.deepEqual(result, { posted: false, reason: 'infrastructure' });
            assert.deepEqual(octokit.comments, []);
            assert.equal(octokit.routes.some(isRerunRoute), false);
        } finally {
            setPullRequestStatusSyncRunner(null);
        }
    });

    test('a code failure next to the network error still posts the follow-up', async () => {
        const redis = createRedis();
        const octokit = createOctokit({ annotations: [
            { annotation_level: 'failure', path: 'test/catalog.test.ts', start_line: 4, message: 'Error: connect ECONNREFUSED 127.0.0.1:8787' },
        ] });
        const result = await postCiFailureFollowup(request(), 'code', { isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never });
        assert.equal(result.reason, 'posted');
        assert.equal(octokit.comments.length, 1);
        assert.equal(octokit.routes.some(isRerunRoute), false);
    });

    test('a test failure followed by a runner loss in an always() cleanup step posts the follow-up', async () => {
        const redis = createRedis();
        const octokit = createOctokit({
            annotations: [
                { annotation_level: 'failure', path: '.github', message: 'Process completed with exit code 1.' },
                { annotation_level: 'failure', path: '.github', message: 'The self-hosted runner: ci-runner-3 lost communication with the server.' },
            ],
            steps: [
                { name: 'Set up job', status: 'completed', conclusion: 'success' },
                { name: 'Run npm test', status: 'completed', conclusion: 'failure' },
                { name: 'Upload test logs', status: 'in_progress', conclusion: null },
            ],
        });
        const result = await postCiFailureFollowup(request(), 'test-then-runner-lost', { isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never });
        assert.equal(result.reason, 'posted');
        assert.equal(octokit.comments.length, 1);
        assert.equal(octokit.routes.some(isRerunRoute), false);
    });

    test('a lockfile failure in one install step next to a network error in another posts the follow-up', async () => {
        const redis = createRedis();
        const octokit = createOctokit({
            annotations: [
                { annotation_level: 'failure', path: '.github', message: 'npm ci can only install packages when your package.json and package-lock.json are in sync. Missing: left-pad@1.3.0 from lock file' },
                { annotation_level: 'failure', path: '.github', message: 'Process completed with exit code 1.' },
                { annotation_level: 'failure', path: '.github', message: 'Error: read ECONNRESET while downloading Chromium' },
            ],
            steps: [
                { name: 'Set up job', status: 'completed', conclusion: 'success' },
                { name: 'Install dependencies', status: 'completed', conclusion: 'failure' },
                { name: 'Install browsers', status: 'completed', conclusion: 'failure' },
                { name: 'Run npm test', status: 'completed', conclusion: 'skipped' },
            ],
        });
        const result = await postCiFailureFollowup(request(), 'lockfile-then-network', { isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never });
        assert.equal(result.reason, 'posted');
        assert.equal(octokit.comments.length, 1);
        assert.equal(octokit.routes.some(isRerunRoute), false);
    });

    test('an unreadable job keeps runner-problem output a code failure', async () => {
        const redis = createRedis();
        const octokit = createOctokit({ jobError: Object.assign(new Error('Not Found'), { status: 404 }) });
        const result = await postCiFailureFollowup(request(), 'job-unreadable', { isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never });
        assert.equal(result.reason, 'posted');
        assert.equal(octokit.comments.length, 1);
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

describe('a compound or ambiguous step is never a setup step', () => {
    test('a step naming a second operation is not setup', () => {
        for (const step of ['Install dependencies and run migrations', 'Setup && seed database', 'Install, then start the server', 'Install Chromium / launch app']) {
            assert.equal(isSetupStep(step), false, step);
        }
    });

    test('a single setup operation and GitHub\'s generated setup action steps are setup', () => {
        for (const step of [
            'Install Chromium', 'npm ci', 'Set up job', 'Run actions/checkout@v4', 'Run actions/setup-node@v4',
            'Run actions/cache@v4', 'Run docker/login-action@v3', 'Post Run actions/checkout@v4',
        ]) {
            assert.equal(isSetupStep(step), true, step);
        }
    });

    test('an action or script that is not a setup operation is not setup', () => {
        for (const step of ['Run actions/github-script@v7', 'Run ./scripts/deploy.sh']) {
            assert.equal(isSetupStep(step), false, step);
        }
    });

    test('a network error in a compound install-and-migrate step is a code failure', () => {
        assert.equal(classifyCiInfrastructureFailure(evidence({
            texts: ['Error: read ECONNRESET'],
            failedSteps: ['Install dependencies and run migrations'],
        })).infrastructure, false);
    });
});

describe('unreadable annotations never make a failure infrastructure', () => {
    const shutdown = 'The runner has received a shutdown signal. This can happen when the runner service is stopped.';

    test('the classifier declines when the annotations could not be read', () => {
        const steps = [{ name: 'Install dependencies', status: 'completed', conclusion: 'failure' }];
        assert.equal(classifyCiInfrastructureFailure(evidence({ texts: [shutdown], annotations: undefined, steps })).infrastructure, false);
        assert.equal(classifyCiInfrastructureFailure(evidence({ texts: [shutdown], annotations: [], steps })).infrastructure, true);
    });

    test('an annotation read failure posts the ordinary follow-up despite runner-problem output', async () => {
        const redis = createRedis();
        const octokit = createOctokit({ annotationsError: Object.assign(new Error('Service Unavailable'), { status: 503 }) });
        const failing = { ...request(), evidence: { ...request().evidence, fallbackExcerpt: shutdown } };
        const result = await postCiFailureFollowup(failing, 'unreadable', { isEnabled: async () => true, getOctokit: async () => octokit, redisClient: redis as never });

        assert.equal(result.reason, 'posted');
        assert.equal(octokit.comments.length, 1);
        assert.equal(octokit.routes.some(isRerunRoute), false);
    });
});
