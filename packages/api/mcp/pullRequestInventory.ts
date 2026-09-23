import { loadAgents, loadSyntheticAgents, loadMonitoredReposRaw, resolveLlmLabel } from '@propr/core';
import type { Knex } from 'knex';
import { McpError } from './config.js';
import type { McpPolicy, McpPrincipal } from './policy.js';
import { markMergedPullRequests } from './tools.js';

/** The live ultrafix circuit breaker; the loop re-reads it before every continuation. */
export const ULTRAFIX_LABEL = 'ultrafix';
/** Managed model routing labels. ProPR keeps exactly one of these on a pull request. */
export const MANAGED_MODEL_LABEL_PREFIX = 'llm-';

// GitHub traffic is bounded by construction: a fixed page size, a page cap per
// repository, a repository cap, a fixed fan-out concurrency, and a hard cap on
// how many pull requests may be enriched with their newest comment.
const PAGE_SIZE = 50;
const MAX_PAGES_PER_REPOSITORY = 4;
const MAX_SCANNED_PER_REPOSITORY = PAGE_SIZE * MAX_PAGES_PER_REPOSITORY;
const MAX_REPOSITORIES = 20;
const REPOSITORY_CONCURRENCY = 4;
export const LATEST_COMMENT_LIMIT = 10;
const LATEST_COMMENT_CONCURRENCY = 4;
const LATEST_COMMENT_EXCERPT = 600;
const MAX_REPOSITORY_LABELS = 200;
const MODEL_CHOICES_IN_ERROR = 30;

const GRAPHQL_STATES: Record<string, string[] | null> = { open: ['OPEN'], merged: ['MERGED'], closed: ['CLOSED'], all: null };

const PULL_REQUESTS_QUERY = `query($owner:String!,$repo:String!,$first:Int!,$after:String,$states:[PullRequestState!],$field:IssueOrderField!){
  repository(owner:$owner,name:$repo){
    pullRequests(first:$first,after:$after,states:$states,orderBy:{field:$field,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{number title state isDraft merged createdAt updatedAt url headRefOid baseRefName reviewDecision
        author{login} labels(first:50){nodes{name}}
        commits(last:1){nodes{commit{statusCheckRollup{state}}}}}
    }
  }
}`;

interface GraphPullRequest {
  number: number; title: string; state: string; isDraft: boolean; merged: boolean;
  createdAt: string; updatedAt: string; url: string; headRefOid: string; baseRefName: string;
  reviewDecision: string | null; author: { login: string } | null;
  labels: { nodes: Array<{ name: string }> } | null;
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> } | null;
}
interface GraphPullRequestPage {
  repository: { pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GraphPullRequest[] } } | null;
}

export interface InventoryOptions {
  repository?: string;
  state: 'open' | 'merged' | 'closed' | 'all';
  openedWithinMinutes?: number;
  updatedWithinMinutes?: number;
  limit: number;
  offset: number;
  includeLatestComment: boolean;
}

export interface InventoryItem extends Record<string, unknown> {
  repository: string; number: number; state: string; createdAt: string; updatedAt: string; labels: string[];
}

/** Bounded fan-out: at most `limit` in-flight operations, results in input order. */
async function mapConcurrent<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await run(items[index]);
    }
  }));
  return results;
}

function minutesAgo(minutes: number | undefined): number | null {
  return minutes ? Date.now() - minutes * 60_000 : null;
}

export function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map(label => typeof label === 'string' ? label : (label as { name?: string } | null)?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

export function hasUltrafixLabel(labels: unknown): boolean {
  return labelNames(labels).some(name => name.toLowerCase() === ULTRAFIX_LABEL);
}

export function managedModelLabels(labels: string[]): string[] {
  return labels.filter(name => name.toLowerCase().startsWith(MANAGED_MODEL_LABEL_PREFIX));
}

/**
 * The repositories this call may read: the grant intersected with currently
 * enabled configured repositories, each verified against live GitHub access.
 * Repositories the credential can no longer read are skipped, not failed.
 */
export async function inventoryRepositories(principal: McpPrincipal, policy: McpPolicy, repository?: string): Promise<{ repositories: string[]; truncated: boolean }> {
  if (repository) return { repositories: [repository], truncated: false };
  const configured = (await loadMonitoredReposRaw()).filter(repo => repo.enabled);
  const repositories: string[] = [];
  let truncated = false;
  for (const repo of configured) {
    if (repositories.length >= MAX_REPOSITORIES) { truncated = true; break; }
    try { await policy.repository(principal, repo.name); repositories.push(repo.name); }
    catch (error) { if (!(error instanceof McpError) || error.status !== 403) throw error; }
  }
  return { repositories, truncated };
}

function projectPullRequest(repository: string, node: GraphPullRequest): InventoryItem {
  const labels = labelNames(node.labels?.nodes);
  return {
    repository, number: node.number, title: node.title, state: String(node.state || '').toLowerCase(),
    draft: Boolean(node.isDraft), merged: Boolean(node.merged), head: node.headRefOid, base: node.baseRefName,
    author: node.author?.login ?? null, url: node.url, createdAt: node.createdAt, updatedAt: node.updatedAt,
    reviewDecision: node.reviewDecision ?? null,
    checksSummary: { state: node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null },
    labels,
    // Replaced with the full correlation block once ProPR's own records are read.
    propr: { ultrafixActive: hasUltrafixLabel(labels) },
  };
}

function orderKey(item: InventoryItem, field: string): number {
  return Date.parse(field === 'UPDATED_AT' ? item.updatedAt : item.createdAt) || 0;
}

async function fetchRepositoryPullRequests(principal: McpPrincipal, repository: string, options: InventoryOptions, field: string): Promise<InventoryItem[]> {
  const [owner, repo] = repository.split('/');
  const cutoff = field === 'UPDATED_AT' ? minutesAgo(options.updatedWithinMinutes) : minutesAgo(options.openedWithinMinutes);
  const scanCap = Math.min(MAX_SCANNED_PER_REPOSITORY, options.offset + options.limit);
  const collected: InventoryItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES_PER_REPOSITORY && collected.length < scanCap; page++) {
    const response: GraphPullRequestPage = await principal.github.graphql<GraphPullRequestPage>(PULL_REQUESTS_QUERY, {
      owner, repo, first: Math.min(PAGE_SIZE, scanCap - collected.length), after, states: GRAPHQL_STATES[options.state] ?? null, field,
    });
    const connection = response.repository?.pullRequests;
    const nodes = connection?.nodes ?? [];
    for (const node of nodes) collected.push(projectPullRequest(repository, node));
    const oldest = collected.at(-1);
    if (!connection?.pageInfo?.hasNextPage || !nodes.length) break;
    // Results are newest-first on the ordering field, so the page after one that
    // already fell outside the window cannot contain anything newer.
    if (cutoff && oldest && orderKey(oldest, field) < cutoff) break;
    after = connection.pageInfo.endCursor;
  }
  return collected;
}

function withinWindow(item: InventoryItem, options: InventoryOptions): boolean {
  const opened = minutesAgo(options.openedWithinMinutes);
  const updated = minutesAgo(options.updatedWithinMinutes);
  if (opened !== null && (Date.parse(item.createdAt) || 0) < opened) return false;
  if (updated !== null && (Date.parse(item.updatedAt) || 0) < updated) return false;
  return true;
}

function parseJobData(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}

function indexByNumber<T extends Record<string, unknown>>(rows: T[], column: string): Map<number, T> {
  const index = new Map<number, T>();
  // Rows arrive newest-first; the first row for a pull request wins.
  for (const row of rows) {
    const number = Number(row[column]);
    if (Number.isSafeInteger(number) && number > 0 && !index.has(number)) index.set(number, row);
  }
  return index;
}

/**
 * The point of this tool: tie each GitHub pull request back to the ProPR task,
 * plan issue or goal that produced it, so an operator does not have to guess.
 */
export async function correlateProprRecords(db: Knex, ownerId: string, repository: string, items: InventoryItem[]): Promise<void> {
  const numbers = [...new Set(items.map(item => item.number))];
  if (!numbers.length) return;
  const [tasks, planIssues, goals] = await Promise.all([
    db('tasks').where({ repository }).whereIn('pr_number', numbers).whereNot('task_type', 'goal')
      .orderBy('created_at', 'desc').select('task_id', 'pr_number', 'issue_number', 'model_name', 'initial_job_data'),
    db('plan_issues').where({ repository }).whereIn('pr_number', numbers)
      .orderBy('id', 'desc').select('id', 'pr_number', 'task_id', 'issue_number', 'agent_alias', 'model_name'),
    db('goals').where({ owner_id: ownerId, repository }).whereIn('final_pr_number', numbers)
      .orderBy('created_at', 'desc').select('goal_id', 'final_pr_number', 'agent_alias', 'requested_model', 'effective_model'),
  ]);
  const taskIndex = indexByNumber(tasks, 'pr_number');
  const planIssueIndex = indexByNumber(planIssues, 'pr_number');
  const goalIndex = indexByNumber(goals, 'final_pr_number');
  for (const item of items) {
    item.propr = proprCorrelation(item, { task: taskIndex.get(item.number), planIssue: planIssueIndex.get(item.number), goal: goalIndex.get(item.number) });
  }
}

type CorrelationRow = Record<string, unknown> | undefined;

function firstValue(...values: unknown[]): unknown {
  for (const value of values) if (value !== undefined && value !== null && value !== '') return value;
  return null;
}

function proprCorrelation(item: InventoryItem, related: { task: CorrelationRow; planIssue: CorrelationRow; goal: CorrelationRow }): Record<string, unknown> {
  const { task, planIssue, goal } = related;
  const job = parseJobData(task?.initial_job_data);
  return {
    taskId: firstValue(task?.task_id, planIssue?.task_id),
    goalId: firstValue(goal?.goal_id),
    planIssueId: firstValue(planIssue?.id),
    issueNumber: firstValue(planIssue?.issue_number, task?.issue_number),
    agentAlias: firstValue(planIssue?.agent_alias, job.agentAlias, goal?.agent_alias),
    modelName: firstValue(task?.model_name, planIssue?.model_name, goal?.effective_model, goal?.requested_model),
    ultrafixActive: hasUltrafixLabel(item.labels),
  };
}

function excerpt(body: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  return normalized.length > LATEST_COMMENT_EXCERPT ? `${normalized.slice(0, LATEST_COMMENT_EXCERPT)}…` : normalized;
}

/**
 * Adds the single newest discussion comment per pull request, for at most
 * `LATEST_COMMENT_LIMIT` of them. Comment prose stays untrusted data.
 */
export async function attachLatestComments(principal: McpPrincipal, items: InventoryItem[]): Promise<boolean> {
  const enriched = items.slice(0, LATEST_COMMENT_LIMIT);
  await mapConcurrent(enriched, LATEST_COMMENT_CONCURRENCY, async item => {
    const [owner, repo] = item.repository.split('/');
    const { data } = await principal.github.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner, repo, issue_number: item.number, per_page: 1, page: 1, sort: 'created', direction: 'desc',
    });
    const comment = data[0];
    item.latestComment = comment ? {
      id: comment.id, author: comment.user?.login ?? null, createdAt: comment.created_at,
      excerpt: excerpt(comment.body || ''), isProprReview: /<!-- propr:ai-review\b/.test(comment.body || ''),
    } : null;
  });
  return items.length > enriched.length;
}

export async function listPullRequestInventory(
  deps: { db: Knex; policy: McpPolicy }, principal: McpPrincipal, options: InventoryOptions,
): Promise<Record<string, unknown>> {
  const { repositories, truncated } = await inventoryRepositories(principal, deps.policy, options.repository);
  const field = options.updatedWithinMinutes && !options.openedWithinMinutes ? 'UPDATED_AT' : 'CREATED_AT';
  const perRepository = await mapConcurrent(repositories, REPOSITORY_CONCURRENCY, async repository => {
    const items = await fetchRepositoryPullRequests(principal, repository, options, field);
    // ProPR's own merge record is authoritative over a stale GitHub projection.
    await markMergedPullRequests(deps.db, repository, items, { number: 'number', state: 'state' });
    return items.filter(item => withinWindow(item, options)
      && (options.state === 'all' || options.state === item.state || (options.state === 'merged' && item.merged)));
  });
  const all = perRepository.flat().sort((left, right) => orderKey(right, field) - orderKey(left, field));
  const page = all.slice(options.offset, options.offset + options.limit);
  const byRepository = new Map<string, InventoryItem[]>();
  for (const item of page) byRepository.set(item.repository, [...byRepository.get(item.repository) ?? [], item]);
  for (const [repository, items] of byRepository) await correlateProprRecords(deps.db, principal.user.id, repository, items);
  const latestCommentTruncated = options.includeLatestComment ? await attachLatestComments(principal, page) : false;
  return {
    repositories, repositoriesTruncated: truncated, order: field === 'UPDATED_AT' ? 'updated' : 'created',
    pullRequests: page, latestCommentTruncated,
    nextOffset: options.offset + options.limit < all.length ? options.offset + options.limit : null,
  };
}

export interface ModelChoice { agentAlias: string; model: string }

/** The enabled agent/model pairs `list_models` already exposes. */
export async function enabledModelChoices(): Promise<ModelChoice[]> {
  const [agents, synthetic] = await Promise.all([loadAgents(), loadSyntheticAgents()]);
  const choices: ModelChoice[] = [];
  for (const agent of agents.filter(agent => agent.enabled)) {
    for (const model of agent.supportedModels) choices.push({ agentAlias: agent.alias, model });
  }
  for (const agent of synthetic.filter(agent => agent.enabled)) {
    for (const model of agent.models.filter(model => model.enabled)) choices.push({ agentAlias: agent.alias, model: model.id });
  }
  return choices;
}

function sameChoice(left: ModelChoice, right: ModelChoice): boolean {
  return left.agentAlias.toLowerCase() === right.agentAlias.toLowerCase() && left.model.toLowerCase() === right.model.toLowerCase();
}

function describeChoices(choices: ModelChoice[]): string {
  const listed = choices.slice(0, MODEL_CHOICES_IN_ERROR).map(choice => `${choice.agentAlias}:${choice.model}`).join(', ');
  return choices.length > MODEL_CHOICES_IN_ERROR ? `${listed}, … (${choices.length} total; read list_models)` : listed || 'none (no agent is enabled)';
}

/**
 * Resolves a requested model through ProPR's existing label resolution and
 * requires it to be an enabled agent/model pair. Never guesses a label.
 */
export async function resolveEnabledModel(requested: string): Promise<ModelChoice> {
  const choices = await enabledModelChoices();
  const resolution = await resolveLlmLabel(requested.replace(/^llm-/i, ''));
  const match = choices.find(choice => sameChoice(choice, resolution));
  if (!match) throw new McpError('UNKNOWN_MODEL', `Model “${requested}” does not resolve to an enabled agent model. Valid choices: ${describeChoices(choices)}.`, 400);
  return match;
}

/** Reads the managed `llm-*` labels this repository actually defines. */
export async function repositoryModelLabels(principal: McpPrincipal, repository: string): Promise<string[]> {
  const [owner, repo] = repository.split('/');
  const names: string[] = [];
  for (let page = 1; page <= 5 && names.length < MAX_REPOSITORY_LABELS; page++) {
    const { data } = await principal.github.request('GET /repos/{owner}/{repo}/labels', { owner, repo, per_page: 100, page });
    names.push(...labelNames(data));
    if (data.length < 100) break;
  }
  return managedModelLabels(names).slice(0, MAX_REPOSITORY_LABELS);
}

/** The repository-defined managed label that resolves to exactly this agent/model. */
export async function findRepositoryModelLabel(definedLabels: string[], choice: ModelChoice): Promise<string | null> {
  for (const label of definedLabels) {
    const resolution = await resolveLlmLabel(label.replace(/^llm-/i, ''));
    if (sameChoice(resolution, choice)) return label;
  }
  return null;
}
