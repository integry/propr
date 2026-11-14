import type { Knex } from 'knex';
import { PluginSdkError, type PluginIssueSummary, type PluginPullRequestSummary, type PluginTaskSummary, type RepositoryEventDomain } from '@propr/shared';
import { listRepositoryEvents } from '../services/repositoryEventJournal.js';
import { generateCorrelationId } from '../utils/logger.js';
import type { IssueJobData } from '../queue/taskQueue.types.js';
import type { PluginCommentTarget, PluginProprBackend } from './pluginProprClient.js';

/** The part of an authenticated Octokit the backend uses. */
export interface PluginGitHubClient {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: unknown }>;
}
export interface GitHubPluginBackendOptions {
  database: Knex;
  /** The ProPR GitHub App client; defaults to the configured one. */
  github?: () => Promise<PluginGitHubClient>;
  /** Queue an issue task job; defaults to the issue queue, as the task API does. */
  enqueueIssueTask?: (data: IssueJobData, jobId: string) => Promise<void>;
  /** The handler run's signal: once aborted no further GitHub request or queued task starts, and requests in flight are cancelled. */
  signal?: AbortSignal;
}

type GitHubIssue = {
  number: number; title: string; state: string; html_url: string; labels?: Array<string | { name?: string }>;
  user?: { login?: string } | null; created_at: string; updated_at: string;
  /** Present when the number is a pull request: GitHub's issue routes serve pull requests too. */
  pull_request?: unknown;
};
type GitHubPull = GitHubIssue & { draft?: boolean; merged?: boolean; merged_at?: string | null; head: { ref: string; sha: string }; base: { ref: string } };

const split = (repository: string) => { const [owner, repo] = repository.split('/'); return { owner, repo }; };
const labelNames = (labels: GitHubIssue['labels']) => (labels ?? []).map(label => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean);
const issueSummary = (repository: string, issue: GitHubIssue): PluginIssueSummary => ({
  repository, number: issue.number, title: issue.title, state: issue.state === 'closed' ? 'closed' : 'open', url: issue.html_url,
  labels: labelNames(issue.labels), author: issue.user?.login ?? null, createdAt: issue.created_at, updatedAt: issue.updated_at,
});

async function defaultGitHub(): Promise<PluginGitHubClient> {
  const { getAuthenticatedOctokit } = await import('../auth/githubAuth.js');
  return await getAuthenticatedOctokit() as unknown as PluginGitHubClient;
}
async function defaultEnqueue(data: IssueJobData, jobId: string): Promise<void> {
  // Loaded on use: the queue module connects to Redis, which a handler that never creates a task does not need.
  const { getIssueQueue } = await import('../queue/taskQueue.js');
  const queue = await getIssueQueue();
  await queue.add('processGitHubIssue', data, { jobId, attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: true });
}

/** The latest recorded state of a task. */
async function taskState(database: Knex, taskId: string): Promise<string | null> {
  const row = await database('task_history').where({ task_id: taskId }).orderBy('history_id', 'desc').first('state');
  return row ? String(row.state) : null;
}

/**
 * The ProPR services `ctx.propr` is built on: GitHub through the ProPR App,
 * the repository event journal, the task tables and the issue task queue.
 * Unscoped: only `scopedProprClient` calls it, after its checks.
 */
export function githubPluginProprBackend(options: GitHubPluginBackendOptions): PluginProprBackend {
  const { database } = options;
  const github = options.github ?? defaultGitHub;
  const enqueue = options.enqueueIssueTask ?? defaultEnqueue;
  const { signal } = options;
  const live = () => { if (signal?.aborted) throw new PluginSdkError('unavailable', 'This handler run has ended'); };
  const request = async <T>(route: string, parameters: Record<string, unknown>) => {
    live();
    const client = await github();
    // The run may have ended while the App token was fetched: nothing is sent for an ended handler.
    live();
    return (await client.request(route, { ...parameters, ...(signal ? { request: { signal } } : {}) })).data as T;
  };
  /**
   * The issue or pull request `number` names, required to be of the kind the
   * operation's permission covers: the issue routes accept either, so the
   * method alone does not establish the target.
   */
  const issueOfKind = async (repository: string, number: number, kind: PluginCommentTarget): Promise<GitHubIssue> => {
    const issue = await request<GitHubIssue>('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...split(repository), issue_number: number });
    if (Boolean(issue.pull_request) !== (kind === 'pull_request')) {
      throw new PluginSdkError('not_found', `${repository}#${number} is not ${kind === 'pull_request' ? 'a pull request' : 'an issue'}`);
    }
    return issue;
  };
  return {
    async getIssue(repository, number) {
      return issueSummary(repository, await issueOfKind(repository, number, 'issue'));
    },
    async getPullRequest(repository, number): Promise<PluginPullRequestSummary> {
      const pull = await request<GitHubPull>('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...split(repository), pull_number: number });
      return { ...issueSummary(repository, pull), draft: Boolean(pull.draft), merged: Boolean(pull.merged ?? pull.merged_at), headRef: pull.head.ref, baseRef: pull.base.ref, headSha: pull.head.sha };
    },
    async getTask(taskId): Promise<PluginTaskSummary | null> {
      const row = await database('tasks').where({ task_id: taskId }).first('task_id', 'repository', 'task_type', 'issue_number', 'model_name', 'created_at', ...(await database.schema.hasColumn('tasks', 'pr_number') ? ['pr_number'] : []));
      if (!row) return null;
      return {
        taskId: row.task_id, repository: row.repository, kind: row.task_type, issueNumber: row.issue_number ?? null, prNumber: row.pr_number ?? null,
        state: await taskState(database, taskId), model: row.model_name ?? null, createdAt: new Date(row.created_at).toISOString(),
      };
    },
    async listEvents(input) {
      return listRepositoryEvents(database, { repository: input.repository, afterSeq: input.afterSeq, domains: input.domains as RepositoryEventDomain[] | undefined, limit: input.limit });
    },
    async createIssue(repository, issue) {
      const created = await request<GitHubIssue>('POST /repos/{owner}/{repo}/issues', { ...split(repository), title: issue.title, body: issue.body, labels: issue.labels });
      return { repository, number: created.number, url: created.html_url };
    },
    async createTask(repository, issueNumber, attribution) {
      const { owner, repo } = split(repository);
      const jobId = `issue-${owner}-${repo}-${issueNumber}`;
      live();
      await enqueue({ repoOwner: owner, repoName: repo, number: issueNumber, requestedBy: attribution.requestedBy, correlationId: generateCorrelationId() }, jobId);
      return { repository, issueNumber, jobId };
    },
    async comment(repository, number, body, target) {
      await issueOfKind(repository, number, target);
      const created = await request<{ id: number; html_url: string }>('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...split(repository), issue_number: number, body });
      return { repository, number, id: created.id, url: created.html_url };
    },
    async addLabel(repository, number, label) {
      await request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { ...split(repository), issue_number: number, labels: [label] });
    },
    async removeLabel(repository, number, label) {
      await request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { ...split(repository), issue_number: number, name: label });
    },
  };
}
