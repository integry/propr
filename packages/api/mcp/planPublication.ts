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
  if (!created.length || created.length !== publication.created.length) return undefined;
  return { state: 'partial', operationId: publication.operationId, created,
    failedIndex: Number(publication.failedIndex), failedAt: publication.failedAt, cause: publication.cause };
}

export function publicationSummary(value: unknown): Record<string, unknown> | null {
  const publication = partialPublication(value);
  return publication ? { state: publication.state, created: publication.created.length,
    failedIndex: publication.failedIndex, cause: publication.cause } : null;
}

/** Find one issue from the bounded newest-first publication recovery window. */
export async function findMarkedIssue(
  principal: McpPrincipal,
  repository: string,
  operationId: string,
  index: number,
): Promise<{ number: number; url: string; title: string } | undefined> {
  const [owner, repo] = repository.split('/');
  const marker = `<!-- propr-mcp:${operationId}:${index} -->`;
  const response = await principal.github.request('GET /repos/{owner}/{repo}/issues', {
    owner, repo, state: 'all', labels: 'propr-planned', sort: 'created', direction: 'desc', per_page: 100, page: 1,
  });
  const issue = response.data.find(candidate => typeof candidate.body === 'string' && candidate.body.includes(marker));
  if (!issue) return undefined;
  return { number: issue.number, url: issue.html_url, title: issue.title };
}
