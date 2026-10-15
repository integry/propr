import type { Redis } from 'ioredis';
import type { Job } from 'bullmq';
import type { IssueJobData } from '../../core/src/queue/taskQueue.types.js';
import { state, add, request, redis, database, FIRST_COMMENT_ID } from './taskFollowupFixture.js';

const { processDetectedIssue } = await import('../../core/src/daemon/issueDetection.js');
const { handleDispatchWithDeps } = await import('../../../src/jobs/issueJobDispatcher.js');
const { findIssueSubmission } = await import('../../core/src/services/taskSubmissionService.js');
const { resolveTaskSubmissionRetry, admittedSubmissionTriggers } = await import('../../core/src/services/taskSubmissionRetry.js');
const { fetchIssueComments } = await import('../../../src/jobs/issueJob/github.js');
const { generateClaudePrompt } = await import('../../core/src/claude/prompts/promptGenerator.js');
const { selectRetryRun, consumeIssueRetryRequest } = await import('../../core/src/services/issueRetryRequest.js');
type IssueRetryRequest = import('../../core/src/services/issueRetryRequest.js').IssueRetryRequest;
type Submission = Awaited<ReturnType<typeof findIssueSubmission>>;

/** The retry requests issue 14 may still owe a run, oldest first. */
export const openRequests = async () => database('issue_retry_request_states').where({ issue_number: 14 }).whereNotNull('owed_issue')
  .orderBy('requested_at').select('comment_id', 'requester_id', 'requested_at', 'publication') as Promise<Array<{ comment_id: number | null; requester_id: string; requested_at: number; publication: string }>>;
export const routes = () => request.mock.calls.map(call => call.arguments[0]);
export const postedComments = () => request.mock.calls.filter(call => call.arguments[0].endsWith('/comments'));

/** The label webhook GitHub delivers for the route's relabel, as the webhook handler admits it. */
export const relabelWebhook = () => processDetectedIssue({
  id: 1014, number: 14, title: 'Issue', url: 'https://github.com/integry/propr/issues/14', repoOwner: 'integry', repoName: 'propr',
  labels: [...state.issueLabels], createdAt: '2026-10-15T09:00:00Z', updatedAt: '2026-10-15T10:00:01Z',
  triggeredBy: 'propr-dev[bot]', triggeredById: '99', source: 'webhook', triggerReapplied: true,
}, 'relabel-webhook', redis as unknown as Redis);

const timelineOctokit = async () => ({ request: async () => ({ data: state.timeline }) }) as never;
export const retryRequestStore = {
  select: (issue: IssueJobData, { submission }: { submission: Submission }) =>
    selectRetryRun(issue, submission ? { admitted: events => admittedSubmissionTriggers(submission, events, database) } : {},
      { getOctokit: timelineOctokit, processingLabels: async () => ['AI'], database, now: () => state.now }),
  consume: async (_issue: IssueJobData, held: IssueRetryRequest) => {
    if (state.consumeFails) throw new Error('SQLITE_BUSY: database is locked');
    await consumeIssueRetryRequest(database, held, state.now);
  },
};

/** Runs the matrix dispatcher on the parent job the queue received at `index`. */
export async function dispatchQueued(index: number) {
  const children: Array<{ jobId: string; data: IssueJobData }> = [];
  const deps = {
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
    retryRequests: retryRequestStore,
  } as unknown as Parameters<typeof handleDispatchWithDeps>[1];
  const [name, data] = add.mock.calls[index].arguments as unknown as [string, IssueJobData];
  const dispatched = await handleDispatchWithDeps({ id: 'issue-integry-propr-14', name, data: { ...data } } as Job<IssueJobData>, deps);
  return { dispatched, children };
}

/** The comments a run on issue 14 reads into its prompt, after the app posted every request. */
export async function promptFor(child: IssueJobData) {
  const issueComments = [
    { id: 1, body: 'An unrelated bot note', user: { login: 'other-app[bot]', type: 'Bot' } },
    ...postedComments().map((posted, index) => ({ id: FIRST_COMMENT_ID + index, body: posted.arguments[1].body!, user: { login: 'propr-dev[bot]', type: 'Bot' } })),
  ];
  const octokit = { request: async () => ({ data: issueComments, headers: {} }) };
  const comments = await fetchIssueComments(octokit as never, child, { warn: () => undefined } as never);
  return generateClaudePrompt({ issueRef: { number: 14, repoOwner: 'integry', repoName: 'propr' }, branchName: 'retry', modelName: 'claude-opus-5-5',
    issueDetails: { title: 'Issue', body: 'Body', comments } });
}
