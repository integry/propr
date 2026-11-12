import { resolvePlanItemIssueDependencies } from '@propr/shared';

/**
 * GitHub "blocked by" links for a published plan.
 *
 * Uses GitHub's issue dependencies REST API (repository permission
 * "Issues: write" for the POST, "Issues: read" for the GETs):
 * - `GET  /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by`
 *   lists the issues the dependant is already blocked by;
 * - `POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by`
 *   with `{ issue_id }` adds a link, where `issue_id` is the blocking issue's
 *   REST `id`, not its number.
 *
 * The documentation does not describe re-adding an existing link, so the
 * existing blockers are listed first and only missing ones are added; a 422 on
 * the add is re-checked against the list. Repeating the step therefore never
 * duplicates a link. Every failure is recorded on its link and logged; nothing
 * here throws, so linking never fails a publication.
 *
 * Sub-issue links need a parent tracking issue; plans have none, so only
 * "blocked by" links are created.
 */

/** Calls the GitHub REST API with an Octokit-style route; installation or user credential. */
export type GitHubRequest = (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;

export interface PlanDependencyLink {
  /** The dependant issue, blocked by `blockedBy`. */
  issue: number;
  blockedBy: number;
  status: 'created' | 'existing' | 'failed';
  error?: string;
}

export interface PlanDependencyLinksResult {
  syncedAt: string;
  links: PlanDependencyLink[];
}

interface LinkLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
}

export interface SyncPlanDependencyLinksOptions {
  request: GitHubRequest;
  owner: string;
  repo: string;
  /** The published plan items, in order, with their `id` and `dependsOn`. */
  plan: readonly unknown[];
  /** Each item's issue number by position; unpublished items are absent. */
  issueNumbers: ReadonlyArray<number | null | undefined>;
  /** REST ids captured when issues were created; missing ones are looked up. */
  issueIds?: ReadonlyMap<number, number>;
  logger?: LinkLogger;
  /** Called before each dependant issue is linked, e.g. to renew a publication claim. Errors propagate. */
  beforeIssue?: (issue: number) => Promise<void>;
}

const BLOCKED_BY_PAGE_SIZE = 100;
const BLOCKED_BY_MAX_PAGES = 10;

function errorMessage(error: unknown): string {
  const status = (error as { status?: unknown })?.status;
  const message = error instanceof Error ? error.message : String(error);
  return typeof status === 'number' ? `${status}: ${message}` : message;
}

function issueNumbersOf(data: unknown): number[] {
  return Array.isArray(data)
    ? data.map(entry => (entry as { number?: unknown })?.number).filter((value): value is number => typeof value === 'number')
    : [];
}

async function listBlockedBy(request: GitHubRequest, owner: string, repo: string, issue: number): Promise<Set<number>> {
  const blockers = new Set<number>();
  for (let page = 1; page <= BLOCKED_BY_MAX_PAGES; page++) {
    const response = await request('GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
      { owner, repo, issue_number: issue, per_page: BLOCKED_BY_PAGE_SIZE, page });
    const numbers = issueNumbersOf(response.data);
    numbers.forEach(number => blockers.add(number));
    if (numbers.length < BLOCKED_BY_PAGE_SIZE) break;
  }
  return blockers;
}

interface Repository { request: GitHubRequest; owner: string; repo: string }

async function addBlockedBy({ request, owner, repo }: Repository, issue: number, blockedBy: number,
  blockedById: number): Promise<'created' | 'existing'> {
  try {
    await request('POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
      { owner, repo, issue_number: issue, issue_id: blockedById });
    return 'created';
  } catch (error) {
    // A concurrent attempt may have added the link since it was listed.
    if ((error as { status?: unknown })?.status !== 422) throw error;
    const recheck = await listBlockedBy(request, owner, repo, issue).catch(() => new Set<number>());
    if (!recheck.has(blockedBy)) throw error;
    return 'existing';
  }
}

/** The dependant → prerequisite issue edges of a published plan. */
export function planDependencyEdges(plan: readonly unknown[], issueNumbers: ReadonlyArray<number | null | undefined>):
  Array<{ issue: number; blockedBy: number[] }> {
  return resolvePlanItemIssueDependencies(plan, issueNumbers)
    .filter(entry => entry.issueNumber !== null && entry.dependsOnIssues.length > 0)
    .map(entry => ({ issue: entry.issueNumber!, blockedBy: entry.dependsOnIssues }));
}

/**
 * Adds a "blocked by" link on GitHub from each published issue to each of its
 * prerequisite issues. Run once every issue of the plan exists. A plan without
 * dependencies makes no GitHub calls and returns null.
 */
export async function syncPlanDependencyLinks(options: SyncPlanDependencyLinksOptions): Promise<PlanDependencyLinksResult | null> {
  const { request, owner, repo, logger } = options;
  const edges = planDependencyEdges(options.plan, options.issueNumbers);
  if (!edges.length) return null;
  const ids = new Map(options.issueIds ?? []);
  const issueId = async (number: number): Promise<number> => {
    const known = ids.get(number);
    if (known !== undefined) return known;
    const response = await request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: number });
    const id = (response.data as { id?: unknown })?.id;
    if (typeof id !== 'number') throw new Error(`GitHub returned no id for issue #${number}`);
    ids.set(number, id);
    return id;
  };

  const links: PlanDependencyLink[] = [];
  for (const edge of edges) {
    if (options.beforeIssue) await options.beforeIssue(edge.issue);
    let existing: Set<number>;
    try { existing = await listBlockedBy(request, owner, repo, edge.issue); }
    catch (error) {
      // The list fails for the same reasons an add would (permission, feature
      // unavailable); skip the adds so nothing is duplicated blindly.
      const message = errorMessage(error);
      edge.blockedBy.forEach(blockedBy => links.push({ issue: edge.issue, blockedBy, status: 'failed', error: message }));
      continue;
    }
    for (const blockedBy of edge.blockedBy) {
      if (existing.has(blockedBy)) {
        links.push({ issue: edge.issue, blockedBy, status: 'existing' });
        continue;
      }
      try {
        const status = await addBlockedBy({ request, owner, repo }, edge.issue, blockedBy, await issueId(blockedBy));
        links.push({ issue: edge.issue, blockedBy, status });
      } catch (error) {
        links.push({ issue: edge.issue, blockedBy, status: 'failed', error: errorMessage(error) });
      }
    }
  }

  const failed = links.filter(link => link.status === 'failed');
  if (failed.length) {
    logger?.warn({ owner, repo, failed }, 'Some GitHub "blocked by" links for the plan were not created');
  } else {
    logger?.info({ owner, repo, links: links.length }, 'GitHub "blocked by" links for the plan are in place');
  }
  return { syncedAt: new Date().toISOString(), links };
}

/** What get_plan shows: counts, and the links that were not created. */
export function summarizePlanDependencyLinks(value: unknown): Record<string, unknown> | null {
  const result = value as Partial<PlanDependencyLinksResult> | null | undefined;
  if (!result || !Array.isArray(result.links)) return null;
  const count = (status: PlanDependencyLink['status']) => result.links!.filter(link => link?.status === status).length;
  return {
    syncedAt: result.syncedAt ?? null,
    created: count('created'),
    existing: count('existing'),
    failed: result.links.filter(link => link?.status === 'failed')
      .map(({ issue, blockedBy, error }) => ({ issue, blockedBy, error: error ?? null })),
  };
}
