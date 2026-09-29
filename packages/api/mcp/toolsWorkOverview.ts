import { z } from 'zod';
import type { McpPrincipal } from './policy.js';
import type { Args, McpTool, ToolDeps } from './tools.js';
import { ok, repositorySchema } from './tools.js';
import { labelNames, ultrafixState } from './pullRequestInventory.js';
import { summarizeReviewComment, type ReviewSummary } from './reviewDiscussion.js';
import { queryTaskSummaries } from './taskListing.js';

const MAX_REPOSITORIES = 5;
const MAX_PULL_REQUESTS_PER_REPOSITORY = 25;
const LABEL_LIMIT = 100;

interface GraphPullRequest {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  merged: boolean;
  headRefOid: string;
  reviewDecision?: string | null;
  mergeStateStatus: string;
  labels: { pageInfo: { hasNextPage: boolean } | null; nodes: Array<{ name: string }> } | null;
  commits?: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> } | null;
  comments: { pageInfo: { hasPreviousPage: boolean } | null; nodes: Array<{ body: string | null; createdAt: string }> } | null;
}

export interface PullRequestOverview {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  head: string;
  reviewDecision: string | null;
  checks: { state: string | null };
  mergeable: string;
  latestReview: ReviewSummary | null;
  latestReviewSearchTruncated: boolean;
  ultrafixActive: boolean | null;
}

type ListScope = (principal: McpPrincipal, args: Args) => Promise<string[] | null>;

function pullRequestSelection(includeChecks: boolean): string {
  return `number url state isDraft merged headRefOid mergeStateStatus
    labels(first:${LABEL_LIMIT}){pageInfo{hasNextPage} nodes{name}}
    ${includeChecks ? 'reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}' : ''}
    comments(last:10){pageInfo{hasPreviousPage} nodes{body createdAt}}`;
}

function summarizePullRequest(node: GraphPullRequest, includeChecks: boolean): PullRequestOverview {
  // GraphQL connections are oldest-first even when selected from the end.
  const reviewComment = [...(node.comments?.nodes ?? [])].reverse()
    .find(comment => /<!-- propr:ai-review\b/.test(comment.body || ''));
  const reviewSearchTruncated = !reviewComment
    && (node.comments === null || Boolean(node.comments?.pageInfo?.hasPreviousPage));
  const labels = labelNames(node.labels?.nodes);
  const labelsTruncated = node.labels === null || Boolean(node.labels?.pageInfo?.hasNextPage);
  return {
    number: node.number,
    url: node.url,
    state: node.merged ? 'merged' : String(node.state || '').toLowerCase(),
    draft: Boolean(node.isDraft),
    head: node.headRefOid,
    reviewDecision: includeChecks ? node.reviewDecision ?? null : null,
    checks: { state: includeChecks ? node.commits?.nodes?.[0]?.commit.statusCheckRollup?.state ?? null : null },
    mergeable: node.mergeStateStatus,
    latestReview: reviewComment ? summarizeReviewComment(reviewComment.body, node.headRefOid) : null,
    latestReviewSearchTruncated: reviewSearchTruncated,
    ultrafixActive: ultrafixState(labels, labelsTruncated),
  };
}

/**
 * Fetch a bounded set of pull requests in one aliased GraphQL request. Callers
 * are responsible for enforcing the repository and per-repository budgets.
 */
export async function enrichPullRequests(
  principal: McpPrincipal,
  repository: string,
  numbers: number[],
  includeChecks = true,
): Promise<Map<number, PullRequestOverview>> {
  const unique = [...new Set(numbers)].filter(number => Number.isSafeInteger(number) && number > 0);
  if (!unique.length) return new Map();
  if (unique.length > MAX_PULL_REQUESTS_PER_REPOSITORY) throw new RangeError(`At most ${MAX_PULL_REQUESTS_PER_REPOSITORY} pull requests may be enriched per repository.`);
  const aliases = unique.map(number => `pr_${number}:pullRequest(number:${number}){${pullRequestSelection(includeChecks)}}`).join('\n');
  const [owner, repo] = repository.split('/');
  const response = await principal.github.graphql<{ repository: Record<string, GraphPullRequest | null> | null }>(
    `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){${aliases}}}`,
    { owner, repo },
  );
  const result = new Map<number, PullRequestOverview>();
  if (!response.repository) return result;
  for (const number of unique) {
    const node = response.repository[`pr_${number}`];
    if (!node) continue;
    result.set(number, summarizePullRequest(node, includeChecks));
  }
  return result;
}

function unavailablePullRequest(task: Record<string, unknown>): Record<string, unknown> {
  return {
    number: Number(task.pr_number),
    state: typeof task.pr_state === 'string' ? task.pr_state : null,
    enrichment: 'unavailable',
  };
}

function unavailableRepositoryError(error: unknown): boolean {
  const candidate = error as { status?: unknown; response?: { status?: unknown } } | null;
  const status = Number(candidate?.status ?? candidate?.response?.status);
  return status === 403 || status === 404;
}

export function addWorkOverviewTools(tools: McpTool[], deps: ToolDeps, listScope: ListScope): void {
  const schema = z.object({
    repository: repositorySchema.optional().describe('Exact repository handle. Omit to list across every repository in this grant.'),
    state: z.enum(['active', 'recent', 'all']).default('active'),
    sinceMinutes: z.number().int().min(1).max(10080).default(1440),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).max(100000).default(0),
    includeChecks: z.boolean().default(true),
  }).strict();
  tools.push({
    name: 'get_work_overview',
    description: 'List running or recently finished task summaries joined to pull request review, check, merge and latest ProPR AI review state. latestReviewSearchTruncated indicates that a null latestReview may exist outside the bounded comment lookup; ultrafixActive is null when the bounded label lookup cannot establish absence. Omit repository to cover every repository in this grant.',
    scope: 'read',
    readOnly: true,
    schema,
    run: async ({ principal, args }) => {
      const repositories = args.repository ? [args.repository] : await listScope(principal, args) ?? [];
      const since = args.state === 'active' ? undefined : Date.now() - args.sinceMinutes * 60_000;
      const tasks = await queryTaskSummaries(deps.db, {
        repositories,
        state: args.state,
        principalUserId: principal.user.id,
        offset: args.offset,
        limit: args.limit,
        since,
        order: 'activity',
      });

      const grouped = new Map<string, number[]>();
      for (const task of tasks) {
        const repository = typeof task.repository === 'string' ? task.repository : null;
        const number = Number(task.pr_number);
        if (!repository || !Number.isSafeInteger(number) || number <= 0) continue;
        const numbers = grouped.get(repository) ?? [];
        if (!numbers.includes(number)) numbers.push(number);
        grouped.set(repository, numbers);
      }
      const requested = [...grouped.values()].reduce((total, numbers) => total + numbers.length, 0);
      let truncated = grouped.size > MAX_REPOSITORIES;
      let completed = 0;
      const enriched = new Map<string, Map<number, PullRequestOverview>>();
      for (const [repository, allNumbers] of [...grouped].slice(0, MAX_REPOSITORIES)) {
        if (allNumbers.length > MAX_PULL_REQUESTS_PER_REPOSITORY) truncated = true;
        const numbers = allNumbers.slice(0, MAX_PULL_REQUESTS_PER_REPOSITORY);
        try {
          const pulls = await enrichPullRequests(principal, repository, numbers, args.includeChecks);
          enriched.set(repository, pulls);
          completed += pulls.size;
        } catch (error) {
          if (!unavailableRepositoryError(error)) throw error;
          // The task page remains useful even when GitHub no longer exposes a repository.
        }
      }

      const items = tasks.map(task => {
        const number = Number(task.pr_number);
        if (!Number.isSafeInteger(number) || number <= 0) return { task, pullRequest: null };
        const repository = String(task.repository);
        const pull = enriched.get(repository)?.get(number);
        if (!pull) return { task, pullRequest: unavailablePullRequest(task) };
        // ProPR's own merge observation is authoritative over GitHub's stale CLOSED state.
        return { task, pullRequest: task.pr_state === 'merged' ? { ...pull, state: 'merged' } : pull };
      });
      return ok({
        items,
        nextOffset: tasks.length === args.limit ? args.offset + args.limit : null,
        githubLookups: { requested, completed, truncated },
      });
    },
  });
}
