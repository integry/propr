import { readFileSync, readlinkSync } from 'node:fs';
import { McpError } from './config.js';
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
  /** Last lease renewal by the owning attempt; the claim time stands in when it is absent. */
  renewedAt?: string;
  owner?: PublicationOwner;
}

/** After a renewal the owning attempt may keep one issue POST in flight for at most this long. */
export const PUBLICATION_LEASE_MS = 60_000;
/** Time for GitHub to settle and list a request that was aborted at the lease deadline. */
export const PUBLICATION_TAKEOVER_GRACE_MS = 60_000;

/** Linux process generation, scoped to the boot and PID namespace we can inspect. */
export interface PublicationOwner {
  bootId: string;
  pidNamespace: string;
  pid: number;
  started: string;
}

function processStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // comm may contain spaces and parentheses; starttime is field 22.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

export function publicationOwner(): PublicationOwner | undefined {
  try {
    return { bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      pidNamespace: readlinkSync('/proc/self/ns/pid'), pid: process.pid, started: processStart(process.pid) };
  } catch { return undefined; }
}

/** A timeout or a different server is not proof of death. Fail closed when unverifiable. */
export function publicationOwnerStopped(owner: PublicationOwner | undefined): boolean {
  const current = publicationOwner();
  if (!owner || !current || owner.bootId !== current.bootId || owner.pidNamespace !== current.pidNamespace
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^\d+$/.test(owner.started)) return false;
  try { return processStart(owner.pid) !== owner.started; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}

/**
 * The owning attempt renews its claim before each issue POST and aborts that
 * POST at the lease deadline, so a claim left unrenewed past the deadline and
 * the settling grace has no request in flight. Unlike the /proc check this
 * holds for an owner in a restarted container or another replica. The later
 * of the claim and its renewal counts, so a future timestamp keeps the door
 * closed only until it passes and an unreadable renewal cannot strand the draft.
 */
export function publicationLeaseLapsesAt(publication: Pick<ActivePublication, 'claimedAt' | 'renewedAt'>): number {
  const claimedAt = Date.parse(publication.claimedAt);
  const renewedAt = Date.parse(publication.renewedAt ?? '');
  const leaseStart = Number.isFinite(renewedAt) ? Math.max(claimedAt, renewedAt) : claimedAt;
  return leaseStart + PUBLICATION_LEASE_MS + PUBLICATION_TAKEOVER_GRACE_MS;
}

export function publicationLeaseLapsed(publication: Pick<ActivePublication, 'claimedAt' | 'renewedAt'>, now = Date.now()): boolean {
  // An unreadable claim time yields NaN, which never compares as lapsed.
  return now > publicationLeaseLapsesAt(publication);
}

export const PUBLICATION_LEASE_EXPIRED = 'PUBLICATION_LEASE_EXPIRED';

/**
 * Send one issue request inside the claim lease. Another attempt may take the
 * claim over once the lease and its grace have passed, so the request never
 * starts after the deadline and is aborted at it. The client's own request
 * timeout is not relied on for that bound.
 */
export async function withinPublicationLease<T>(leaseDeadline: number, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const remaining = leaseDeadline - Date.now();
  if (remaining <= 0) throw new McpError(PUBLICATION_LEASE_EXPIRED,
    'The publication claim was not renewed in time. No issue was created for this task.', 409,
    { stage: 'database', retryable: true });
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('The issue request exceeded the publication lease.', 'TimeoutError')), remaining);
  try { return await send(deadline.signal); }
  finally { clearTimeout(timer); }
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
    || typeof publication.claimedAt !== 'string' || !Number.isFinite(Date.parse(publication.claimedAt))) return undefined;
  const created = publication.created.filter((issue): issue is PublishedIssue => !!issue
    && Number.isInteger(issue.index) && issue.index >= 0 && Number.isInteger(issue.number) && issue.number > 0
    && typeof issue.url === 'string');
  if (created.length !== publication.created.length) return undefined;
  return { state: 'active', operationId: publication.operationId, attemptId: publication.attemptId,
    created, claimedAt: publication.claimedAt,
    ...(typeof publication.renewedAt === 'string' ? { renewedAt: publication.renewedAt } : {}), owner: publication.owner };
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
