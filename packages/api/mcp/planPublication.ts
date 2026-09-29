import type { McpPrincipal } from './policy.js';

export interface PublishedIssue {
  index: number;
  number: number;
  url: string;
}

export interface PartialPublication {
  state: 'partial';
  operationId: string;
  created: PublishedIssue[];
  failedIndex: number;
  failedAt: string;
  cause: { code: string; message: string };
}

export interface ActivePublication {
  state: 'active';
  operationId: string;
  attemptId: string;
  created: PublishedIssue[];
  claimedAt: string;
}

export type MarkerLookup = { state: 'found'; issue: { number: number; url: string; title: string } }
  | { state: 'absent' }
  | { state: 'incomplete' };

const MARKER_LOOKUP_PAGE_SIZE = 100;
const MARKER_LOOKUP_MAX_PAGES = 10;

export function parseContextConfig(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value as Record<string, unknown> };
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function partialPublication(value: unknown): PartialPublication | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const publication = value as Partial<PartialPublication>;
  if (publication.state !== 'partial' || typeof publication.operationId !== 'string'
    || !Array.isArray(publication.created) || !Number.isInteger(publication.failedIndex)
    || typeof publication.failedAt !== 'string' || !publication.cause
    || typeof publication.cause.code !== 'string' || typeof publication.cause.message !== 'string') return undefined;
  const created = publication.created.filter((issue): issue is PublishedIssue => !!issue
    && Number.isInteger(issue.index) && issue.index >= 0 && Number.isInteger(issue.number) && issue.number > 0
    && typeof issue.url === 'string');
  if (created.length !== publication.created.length) return undefined;
  return { state: 'partial', operationId: publication.operationId, created,
    failedIndex: Number(publication.failedIndex), failedAt: publication.failedAt, cause: publication.cause };
}

export function activePublication(value: unknown): ActivePublication | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const publication = value as Partial<ActivePublication>;
  if (publication.state !== 'active' || typeof publication.operationId !== 'string'
    || typeof publication.attemptId !== 'string' || !Array.isArray(publication.created)
    || typeof publication.claimedAt !== 'string') return undefined;
  const created = publication.created.filter((issue): issue is PublishedIssue => !!issue
    && Number.isInteger(issue.index) && issue.index >= 0 && Number.isInteger(issue.number) && issue.number > 0
    && typeof issue.url === 'string');
  if (created.length !== publication.created.length) return undefined;
  return { state: 'active', operationId: publication.operationId, attemptId: publication.attemptId,
    created, claimedAt: publication.claimedAt };
}

export function publicationSummary(value: unknown): Record<string, unknown> | null {
  const publication = partialPublication(value);
  if (publication) return { state: publication.state, created: publication.created.length,
    failedIndex: publication.failedIndex, cause: publication.cause };
  const active = activePublication(value);
  return active ? { state: active.state, created: active.created.length } : null;
}

/** Find an issue marker, proving absence only after the relevant creation window was exhausted. */
export async function findMarkedIssue(
  principal: McpPrincipal,
  repository: string,
  options: { operationId: string; index: number; afterIssueNumber?: number },
): Promise<MarkerLookup> {
  const [owner, repo] = repository.split('/');
  const marker = `<!-- propr-mcp:${options.operationId}:${options.index} -->`;
  const afterIssueNumber = options.afterIssueNumber;
  for (let page = 1; page <= MARKER_LOOKUP_MAX_PAGES; page++) {
    // Labels are intentionally omitted: users and automation may remove them
    // after creation, but the operation marker remains the recovery authority.
    const response = await principal.github.request('GET /repos/{owner}/{repo}/issues', {
      owner, repo, state: 'all', sort: 'created', direction: 'desc', per_page: MARKER_LOOKUP_PAGE_SIZE, page,
    });
    const issue = response.data.find(candidate => typeof candidate.body === 'string' && candidate.body.includes(marker));
    if (issue) return { state: 'found', issue: { number: issue.number, url: issue.html_url, title: issue.title } };
    if (response.data.length < MARKER_LOOKUP_PAGE_SIZE
      || (afterIssueNumber !== undefined && response.data.some(candidate => candidate.number <= afterIssueNumber))) {
      return { state: 'absent' };
    }
  }
  return { state: 'incomplete' };
}
