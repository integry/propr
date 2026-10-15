import assert from 'node:assert/strict';
import type { Redis } from 'ioredis';
import type { Job } from 'bullmq';
import type { IssueJobData } from '../../core/src/queue/taskQueue.types.js';
import { state, claims, add, request, redis, database } from './taskFollowupFixture.js';

const { processDetectedIssue } = await import('../../core/src/daemon/issueDetection.js');
const { handleDispatchWithDeps } = await import('../../../src/jobs/issueJobDispatcher.js');
const { findIssueSubmission, insertTaskSubmission } = await import('../../core/src/services/taskSubmissionService.js');
const { resolveTaskSubmissionRetry, admittedSubmissionTriggers } = await import('../../core/src/services/taskSubmissionRetry.js');
const { fetchIssueComments } = await import('../../../src/jobs/issueJob/github.js');
const { generateClaudePrompt } = await import('../../core/src/claude/prompts/promptGenerator.js');
const { selectRetryRun, consumeIssueRetryRequest, confirmIssueRetryPublication, redisRetryOutcomeEvidence } = await import('../../core/src/services/issueRetryRequest.js');
type IssueRetryRequest = import('../../core/src/services/issueRetryRequest.js').IssueRetryRequest;
type Submission = Awaited<ReturnType<typeof findIssueSubmission>>;

/** The retry requests issue 14 may still owe a run, oldest first. */
export const openRequests = async () => database('issue_retry_request_states').where({ issue_number: 14 }).whereNotNull('owed_issue')
  .orderBy('requested_at').select('comment_id', 'requester_id', 'requested_at', 'published_at', 'publication') as Promise<Array<{ comment_id: number | null; requester_id: string; requested_at: number; published_at: number | null; publication: string }>>;
export const routes = () => request.mock.calls.map(call => call.arguments[0]);
export const postedComments = () => request.mock.calls.filter(call => call.arguments[0].endsWith('/comments'));

/** The label webhook GitHub delivers for the route's relabel, as the webhook handler admits it. */
export const relabelWebhook = () => processDetectedIssue({
  id: 1014, number: 14, title: 'Issue', url: 'https://github.com/integry/propr/issues/14', repoOwner: 'integry', repoName: 'propr',
  labels: [...state.issueLabels], createdAt: '2026-10-15T09:00:00Z', updatedAt: '2026-10-15T10:00:01Z',
  triggeredBy: 'propr-dev[bot]', triggeredById: '99', source: 'webhook', triggerReapplied: true,
}, 'relabel-webhook', redis as unknown as Redis);

/** The issue as the daemon's poll detects it while its trigger label is on it. */
export const pollDelivery = () => processDetectedIssue({
  id: 1014, number: 14, title: 'Issue', url: 'https://github.com/integry/propr/issues/14', repoOwner: 'integry', repoName: 'propr',
  labels: [...state.issueLabels], createdAt: '2026-10-15T09:00:00Z', updatedAt: '2026-10-15T10:00:01Z',
  triggeredBy: 'propr-dev[bot]', triggeredById: '99', source: 'polling',
}, 'poll', redis as unknown as Redis);

const timelineOctokit = async () => ({ request: async () => ({ data: state.timeline }) }) as never;
type RetryOutcomeEvidence = ReturnType<typeof redisRetryOutcomeEvidence>;
/** The trigger write outcomes the route kept in Redis because it could not record them. */
export const retryOutcomes = redisRetryOutcomeEvidence(() => redis);
/** The production retry request store, on the test database and the given outcome evidence. */
export const retryRequestStoreFor = (outcomes: RetryOutcomeEvidence) => ({
  select: (issue: IssueJobData, { submission }: { submission: Submission }) =>
    selectRetryRun(issue, submission ? { admitted: events => admittedSubmissionTriggers(submission, events, database), consumedEventId: submission.retry_event_id } : {},
      { getOctokit: timelineOctokit, processingLabels: async () => ['AI'], database, now: () => state.now }),
  evidence: (_issue: IssueJobData, held: IssueRetryRequest) => outcomes.read(held),
  confirm: async (_issue: IssueJobData, held: IssueRetryRequest, publication: 'possible' | 'refused') => {
    if (state.confirmFails) throw new Error('SQLITE_BUSY: database is locked');
    await confirmIssueRetryPublication({ database, evidence: outcomes }, held, publication, state.now);
  },
  consume: async (_issue: IssueJobData, held: IssueRetryRequest) => {
    if (state.consumeFails) throw new Error('SQLITE_BUSY: database is locked');
    await consumeIssueRetryRequest(database, held, state.now);
  },
});
export const retryRequestStore = retryRequestStoreFor(retryOutcomes);

/** The matrix dispatcher's dependencies on the test database and GitHub, collecting the child jobs it adds. */
export function dispatcherDeps(children: Array<{ jobId: string; data: IssueJobData }>, retryRequests = retryRequestStore) {
  return {
    findSubmission: (issue: IssueJobData) => findIssueSubmission(issue, database),
    resolveSubmissionRetry: (submission: Parameters<typeof resolveTaskSubmissionRetry>[0]) => resolveTaskSubmissionRetry(submission, database,
      timelineOctokit, async () => ['AI']),
    // The durable receipt the production dispatcher records.
    recordDispatch: async (id: string, triggerEventId?: string) => {
      await database('task_submissions').where({ id }).update({ dispatch_complete: true, ...(triggerEventId ? { retry_event_id: triggerEventId } : {}) });
    },
    recordDispatchFailure: async () => undefined,
    getAuthenticatedOctokit: async () => ({ request: async () => ({ data: { labels: state.issueLabels.map(name => ({ name })) } }) }),
    withRetry: async (operation: () => Promise<unknown>) => operation(), retryConfigs: { githubApi: {} },
    validateRepositoryInfo: async () => ({ isValid: true, repoData: { defaultBranch: 'main' } }),
    resolveLlmLabel: async () => ({ agentAlias: 'claude', model: 'claude-opus-5-5' }),
    getAllCustomLabels: async () => [], getDefaultModel: () => 'claude-opus-5-5',
    issueQueue: { add: async (_name: string, data: IssueJobData, options: { jobId: string }) => { children.push({ jobId: options.jobId, data }); } },
    retryRequests,
  } as unknown as Parameters<typeof handleDispatchWithDeps>[1];
}

/** Runs the matrix dispatcher on the parent job the queue received at `index`. */
export async function dispatchQueued(index: number) {
  const children: Array<{ jobId: string; data: IssueJobData }> = [];
  const deps = dispatcherDeps(children);
  const [name, data] = add.mock.calls[index].arguments as unknown as [string, IssueJobData];
  const dispatched = await handleDispatchWithDeps({ id: 'issue-integry-propr-14', name, data: { ...data } } as Job<IssueJobData>, deps);
  return { dispatched, children };
}

/** The comments a run on issue 14 reads into its prompt, after the app posted every request, with the IDs GitHub gave them. */
export async function promptFor(child: IssueJobData) {
  const posted = await Promise.all(postedComments().map(async call => {
    const created = await (call.result as Promise<{ data: { id: number } }> | undefined)?.catch(() => undefined);
    return created && { id: created.data.id, body: call.arguments[1].body!, user: { login: 'propr-dev[bot]', type: 'Bot' } };
  }));
  const issueComments = [
    { id: 1, body: 'An unrelated bot note', user: { login: 'other-app[bot]', type: 'Bot' } },
    ...posted.filter(comment => comment !== undefined),
  ];
  const octokit = { request: async () => ({ data: issueComments, headers: {} }) };
  const comments = await fetchIssueComments(octokit as never, child, { warn: () => undefined } as never);
  return generateClaudePrompt({ issueRef: { number: 14, repoOwner: 'integry', repoName: 'propr' }, branchName: 'retry', modelName: 'claude-opus-5-5',
    issueDetails: { title: 'Issue', body: 'Body', comments } });
}

/** The window issue 14's relabel webhook shares with the route. */
export const dedupKey = 'issue:dedup:integry:propr:14';

/** Takes the durable request records offline, as when the database is unavailable, until the returned restore runs. */
export async function takeRecordsOffline() {
  await database.schema.renameTable('issue_retry_request_states', 'issue_retry_request_states_offline');
  return async () => { await database.schema.renameTable('issue_retry_request_states_offline', 'issue_retry_request_states'); };
}

/** Runs `body` on issue 14 with or without a submission whose initial run was dispatched and failed. */
export async function onIssue(backed: boolean, key: string, body: () => Promise<void>) {
  const row = backed ? await insertTaskSubmission(database, { user_id: 'submitter', submission_key: key,
    payload_hash: 'hash', repository: 'integry/propr', payload: '{}', attachments: '[]' }) : null;
  try {
    if (row) await database('task_submissions').where({ id: row.id }).update({ issue_number: 14, task_id: 'failed-issue-task', dispatch_complete: true });
    await body();
  } finally {
    if (row) await database('task_submissions').where({ id: row.id }).delete();
  }
}

/** Delivers the issue's relabel (or a poll) after the shared window and dispatches the recovery job it queues, not an earlier job. */
export async function deliverAndDispatch(deliver: () => ReturnType<typeof processDetectedIssue> = relabelWebhook) {
  claims.delete(dedupKey);
  const index = add.mock.callCount();
  assert.notEqual((await deliver()).status, 'ignored');
  assert.equal(add.mock.callCount(), index + 1, 'the relabel queues one recovery job');
  const [, recovery] = add.mock.calls[index].arguments as unknown as [string, IssueJobData];
  assert.equal(recovery.retryCommentId, undefined, 'the relabel delivery carries no retry metadata');
  assert.equal(recovery.retryRequesterId, undefined);
  return dispatchQueued(index);
}
