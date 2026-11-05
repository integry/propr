/**
 * Guards the delivery_interest.v1 declaration against the handlers it describes.
 * Every candidate delivery the relay would drop under the declaration is run
 * through the real webhook handler, which must not touch GitHub, Redis, the
 * merge-conflict settings, a processor or the Ultrafix hook for it. A handler
 * that starts acting on an excluded action/state/ref fails here until its gate
 * in webhookEventGates.ts (and so the declaration) is widened.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';

const touches: string[] = [];
const touch = (what: string) => { touches.push(what); };

function countingProxy(name: string): object {
    return new Proxy({}, {
        get: (_target, property) => {
            if (property === 'then') return undefined;
            touch(`${name}.${String(property)}`);
            return async () => null;
        },
    });
}

await mock.module('ioredis', { namedExports: { Redis: function Redis() { return countingProxy('redis'); } } });
await mock.module('bullmq', { namedExports: {
    ErrorCode: { JobNotExist: -1, JobNotInState: -3 },
    Queue: function Queue() { return countingProxy('queue'); },
    QueueEvents: function QueueEvents() { return countingProxy('queue-events'); },
    Worker: function Worker() { return countingProxy('worker'); },
} });
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: {
    getGitHubInstallationToken: async () => { touch('github.token'); throw new Error('offline'); },
    getAuthenticatedOctokit: async () => {
        touch('github.octokit');
        return { request: async (endpoint: string) => { touch(`github ${endpoint}`); throw new Error('offline'); }, paginate: async () => { touch('github.paginate'); return []; } };
    },
} });
const resolution = await import('../packages/core/src/config/mergeConflictSettingsResolution.js');
await mock.module('../packages/core/src/config/mergeConflictSettings.js', { namedExports: {
    ...resolution,
    loadInstanceAutoResolveMergeConflicts: async () => false,
    loadAutoResolveRepositoryConfigs: async () => [],
    loadEffectiveAutoResolveMergeConflicts: async () => { touch('merge-conflict-settings'); return { enabled: false, source: 'instance' }; },
} });

const { initializeWebhookHandler, processWebhookEvent, getWebhookDeliveryInterest } = await import('../packages/core/src/webhook/webhookHandler.js');
const { setUltrafixCheckRunHook } = await import('../packages/core/src/webhook/checkRunHandler.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
type DeliveryInterest = ReturnType<typeof getWebhookDeliveryInterest>;
after(closeConnection);

setUltrafixCheckRunHook(async () => { touch('ultrafix-hook'); });

const MONITORED = 'acme/widgets';
const monitored = Object.assign((repository: string) => repository.trim().toLowerCase() === MONITORED,
    { monitoredRepositories: () => [MONITORED] });

async function initialize(withCheckRunProcessor = false): Promise<void> {
    await initializeWebhookHandler({
        issueProcessor: async () => { touch('issue-processor'); },
        commentProcessor: async () => { touch('comment-processor'); },
        commentDeletedHandler: async () => { touch('comment-deleted'); },
        commentEditedHandler: async () => { touch('comment-edited'); },
        pullRequestProcessor: async () => { touch('pull-request-processor'); },
        ...(withCheckRunProcessor ? { checkRunProcessor: async () => { touch('check-run-processor'); } } : {}),
        redisClient: countingProxy('webhook-redis') as never,
        repositoryFilter: monitored,
    });
}

beforeEach(async () => {
    touches.length = 0;
    await initialize();
});

/** The relay's documented matching semantics (propr-routing#294), read as aggressively as allowed. */
function relayWouldForward(interest: DeliveryInterest, eventType: string, payload: Record<string, any>): boolean {
    const repository = typeof payload.repository?.full_name === 'string' ? payload.repository.full_name.toLowerCase() : undefined;
    if (interest.repositories !== '*' && repository !== undefined && !interest.repositories.includes(repository)) return false;
    const rule = interest.events[eventType];
    if (!rule) return false;
    if (rule.actions && typeof payload.action === 'string' && !rule.actions.includes(payload.action)) return false;
    if (rule.states && typeof payload.state === 'string' && !rule.states.includes(payload.state)) return false;
    const subject = payload.check_run ?? payload.check_suite;
    // Strictest reading: a null conclusion is "not listed", so it is dropped too.
    if (rule.conclusions && subject && !rule.conclusions.includes(subject.conclusion)) return false;
    if (rule.refPrefixes && typeof payload.ref === 'string' && !rule.refPrefixes.some(prefix => payload.ref.startsWith(prefix))) return false;
    if (rule.excludeDeleted && payload.deleted === true) return false;
    return true;
}

const repository = { full_name: MONITORED, name: 'widgets', owner: { login: 'acme' } };
const CHECK_RUN_ACTIONS = ['completed', 'created', 'requested_action', 'rerequested'];
const CHECK_SUITE_ACTIONS = ['completed', 'requested', 'rerequested'];
const CONCLUSIONS = [null, 'success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required', 'stale', 'skipped', 'startup_failure'];
const STATUS_STATES = ['pending', 'success', 'failure', 'error'];
const sha = 'a'.repeat(40);

function candidates(): Array<{ eventType: string; payload: Record<string, any> }> {
    const list: Array<{ eventType: string; payload: Record<string, any> }> = [];
    for (const action of CHECK_RUN_ACTIONS) for (const conclusion of CONCLUSIONS) {
        list.push({ eventType: 'check_run', payload: { repository, action, check_run: {
            id: 1, name: 'ci', head_sha: sha, conclusion, pull_requests: [], output: { title: null, summary: null, text: null, annotations_count: 0 },
        } } });
    }
    for (const action of CHECK_SUITE_ACTIONS) for (const conclusion of CONCLUSIONS) {
        list.push({ eventType: 'check_suite', payload: { repository, action, check_suite: { head_sha: sha, conclusion, pull_requests: [] } } });
    }
    for (const state of STATUS_STATES) {
        list.push({ eventType: 'status', payload: { repository, sha, state, context: 'ci' } });
    }
    for (const ref of ['refs/heads/main', 'refs/tags/v1.0.0', 'refs/pull/7/head', 'refs/notes/commits']) for (const deleted of [false, true]) {
        list.push({ eventType: 'push', payload: { repository, ref, deleted, commits: [] } });
    }
    return list;
}

async function deliver(eventType: string, payload: Record<string, any>): Promise<void> {
    await processWebhookEvent(payload, eventType as never, `guard-${eventType}`);
    // Conflict detection runs outside the delivery; let it reach its first gate.
    await new Promise(resolve => setImmediate(resolve));
}

test('every CI/push delivery the declaration excludes is one the handlers ignore', async () => {
    const interest = getWebhookDeliveryInterest();
    let excluded = 0;
    for (const { eventType, payload } of candidates()) {
        if (relayWouldForward(interest, eventType, payload)) continue;
        excluded += 1;
        touches.length = 0;
        await deliver(eventType, payload);
        assert.deepEqual(touches, [], `${eventType} ${JSON.stringify({ action: payload.action, state: payload.state, ref: payload.ref, deleted: payload.deleted, conclusion: (payload.check_run ?? payload.check_suite)?.conclusion })} is declared unwanted but the handler acted on it`);
    }
    // 30 check_run (non-completed) + 27 check_suite + 1 status + 7 push.
    assert.equal(excluded, 65);
});

test('the probe detects work: forwarded deliveries do reach GitHub, settings or hooks', async () => {
    const probes: Array<[string, Record<string, any>]> = [
        ['check_run', candidates().find(c => c.eventType === 'check_run' && c.payload.action === 'completed' && c.payload.check_run.conclusion === 'success')!.payload],
        ['check_suite', { repository, action: 'completed', check_suite: { head_sha: sha, conclusion: 'skipped', pull_requests: [] } }],
        ['status', { repository, sha, state: 'success', context: 'ci' }],
        ['status', { repository, sha, state: 'error', context: 'ci' }],
        ['push', { repository, ref: 'refs/heads/main', deleted: false, commits: [] }],
    ];
    const interest = getWebhookDeliveryInterest();
    for (const [eventType, payload] of probes) {
        assert.equal(relayWouldForward(interest, eventType, payload), true);
        touches.length = 0;
        await deliver(eventType, payload);
        assert.notDeepEqual(touches, [], `${eventType} ${payload.state ?? payload.action} should have been acted on`);
    }
});

test('unmonitored repositories are excluded for every event and ignored by the handler', async () => {
    const interest = getWebhookDeliveryInterest();
    assert.deepEqual(interest.repositories, [MONITORED]);
    const other = { full_name: 'acme/other', name: 'other', owner: { login: 'acme' } };
    const payloads: Array<[string, Record<string, any>]> = [
        ['issues', { repository: other, action: 'closed', issue: { number: 1 } }],
        ['issues', { repository: other, action: 'unlabeled', label: { name: 'ultrafix' }, issue: { number: 1, pull_request: {} } }],
        ['issue_comment', { repository: other, action: 'created', issue: { number: 1, pull_request: {} }, comment: { id: 1 } }],
        ['pull_request', { repository: other, action: 'closed', pull_request: { number: 1, merged: true } }],
        ['pull_request_review_comment', { repository: other, action: 'created', pull_request: { number: 1 }, comment: { id: 1 } }],
        ['check_run', { repository: other, action: 'completed', check_run: { head_sha: sha, conclusion: 'failure', pull_requests: [{ number: 1 }], output: {} } }],
        ['push', { repository: other, ref: 'refs/heads/main', deleted: false, commits: [] }],
    ];
    for (const [eventType, payload] of payloads) {
        assert.equal(relayWouldForward(interest, eventType, payload), false);
        touches.length = 0;
        await deliver(eventType, payload);
        assert.deepEqual(touches, [], `${eventType} for an unmonitored repository was acted on`);
    }
});

test('a registered check-run processor sees every action, so check_run is then unfiltered', async () => {
    await initialize(true);
    assert.deepEqual(getWebhookDeliveryInterest().events.check_run, {});
    touches.length = 0;
    await deliver('check_run', { repository, action: 'created', check_run: { head_sha: sha, conclusion: null, pull_requests: [], output: {} } });
    assert.deepEqual(touches, ['check-run-processor']);
});

test('without a repository filter (or with an opaque one) every repository is wanted', async () => {
    await initializeWebhookHandler({
        issueProcessor: async () => {}, commentProcessor: async () => {}, commentDeletedHandler: async () => {}, commentEditedHandler: async () => {},
    });
    assert.equal(getWebhookDeliveryInterest().repositories, '*');
    await initializeWebhookHandler({
        issueProcessor: async () => {}, commentProcessor: async () => {}, commentDeletedHandler: async () => {}, commentEditedHandler: async () => {},
        repositoryFilter: () => true,
    });
    assert.equal(getWebhookDeliveryInterest().repositories, '*');
});
