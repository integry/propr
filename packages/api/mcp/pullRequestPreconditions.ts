import { McpError } from './config.js';

interface CheckContext {
  name?: string | null;
  conclusion?: string | null;
  status?: string | null;
  context?: string | null;
  state?: string | null;
}

interface CheckRollup {
  state?: string | null;
  contexts?: {
    nodes?: Array<CheckContext | null> | null;
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
  } | null;
}

/** The REST and GraphQL fields needed to describe a pull request without another GitHub call. */
export interface PullRequestStateSource {
  number?: number;
  state?: string | null;
  draft?: boolean | null;
  isDraft?: boolean | null;
  merged?: boolean | null;
  merged_at?: string | null;
  mergedAt?: string | null;
  merge_commit_sha?: string | null;
  mergeCommitSha?: string | null;
  mergeCommit?: { oid?: string | null } | null;
  closed_at?: string | null;
  closedAt?: string | null;
  head?: string | { sha?: string | null } | null;
  headRefOid?: string | null;
  base?: string | { ref?: string | null } | null;
  baseRefName?: string | null;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  checks?: PullRequestChecks | null;
  commits?: number | { nodes?: Array<{ commit?: { id?: string | null; statusCheckRollup?: CheckRollup | null } | null } | null> | null } | null;
  html_url?: string | null;
  url?: string | null;
}

export interface PullRequestChecks {
  state: string | null;
  failing: string[];
  pending: string[];
}

export interface PullRequestSnapshot {
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  closedAt: string | null;
  head: string | null;
  base: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  checks: PullRequestChecks;
  url: string | null;
}

const FAILURE_CONCLUSIONS = new Set(['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT']);
const FAILURE_STATES = new Set(['ERROR', 'FAILURE']);
const PENDING_STATES = new Set(['EXPECTED', 'PENDING']);

const upper = (value: string | null | undefined): string | null => value ? value.toUpperCase() : null;

function checkRollup(source: PullRequestStateSource): CheckRollup | null {
  const nodes = typeof source.commits === 'object' && source.commits ? source.commits.nodes ?? [] : [];
  return nodes[nodes.length - 1]?.commit?.statusCheckRollup ?? null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function checksSnapshot(source: PullRequestStateSource): PullRequestChecks {
  if (source.checks) return {
    state: upper(source.checks.state),
    failing: unique(source.checks.failing),
    pending: unique(source.checks.pending),
  };
  const rollup = checkRollup(source);
  const failing: string[] = [];
  const pending: string[] = [];
  for (const item of rollup?.contexts?.nodes ?? []) {
    if (!item) continue;
    const name = item.name ?? item.context;
    if (!name) continue;
    const conclusion = upper(item.conclusion);
    const status = upper(item.status);
    const state = upper(item.state);
    if ((conclusion && FAILURE_CONCLUSIONS.has(conclusion)) || (state && FAILURE_STATES.has(state))) failing.push(name);
    else if ((status && status !== 'COMPLETED') || (!conclusion && !!status) || (state && PENDING_STATES.has(state))) pending.push(name);
  }
  return { state: upper(rollup?.state), failing: unique(failing), pending: unique(pending) };
}

function head(source: PullRequestStateSource): string | null {
  if (source.headRefOid) return source.headRefOid;
  if (typeof source.head === 'string') return source.head;
  return source.head?.sha ?? null;
}

function base(source: PullRequestStateSource): string | null {
  if (source.baseRefName) return source.baseRefName;
  if (typeof source.base === 'string') return source.base;
  return source.base?.ref ?? null;
}

/** Project the REST pull request plus optional GraphQL merge data into one stable diagnostic shape. */
// eslint-disable-next-line complexity -- REST and GraphQL spell the same nullable lifecycle fields differently
export function pullRequestSnapshot(pr: PullRequestStateSource, graph?: PullRequestStateSource): PullRequestSnapshot {
  const current = graph ?? pr;
  const merged = Boolean(pr.merged || graph?.merged || upper(pr.state) === 'MERGED' || upper(graph?.state) === 'MERGED');
  const rawState = upper(graph?.state ?? pr.state);
  return {
    state: merged ? 'merged' : rawState === 'OPEN' ? 'open' : 'closed',
    draft: Boolean(graph?.isDraft ?? graph?.draft ?? pr.isDraft ?? pr.draft),
    merged,
    mergedAt: graph?.mergedAt ?? pr.mergedAt ?? pr.merged_at ?? null,
    mergeCommitSha: graph?.mergeCommit?.oid ?? graph?.mergeCommitSha ?? pr.mergeCommit?.oid ?? pr.mergeCommitSha ?? pr.merge_commit_sha ?? null,
    closedAt: graph?.closedAt ?? pr.closedAt ?? pr.closed_at ?? null,
    head: head(current) ?? head(pr),
    base: base(current) ?? base(pr),
    mergeStateStatus: upper(current.mergeStateStatus),
    reviewDecision: upper(current.reviewDecision),
    checks: checksSnapshot(current),
    url: current.url ?? current.html_url ?? pr.url ?? pr.html_url ?? null,
  };
}

function pullRequestName(pr: PullRequestStateSource): string {
  return Number.isSafeInteger(pr.number) ? `#${pr.number}` : 'the pull request';
}

// eslint-disable-next-line max-params -- every error needs its stable code, sentence, failed guard, snapshot and optional detail
function preconditionError(
  code: string,
  message: string,
  failedPrecondition: string,
  currentState: PullRequestSnapshot,
  options: { retryable?: boolean; details?: Record<string, unknown> } = {},
): McpError {
  return new McpError(code, message, 409, {
    stage: 'precondition',
    retryable: options.retryable ?? false,
    details: { currentState, failedPrecondition, ...options.details },
  });
}

function assertOpenState(pr: PullRequestStateSource, action: string, snapshot: PullRequestSnapshot): void {
  const name = pullRequestName(pr);
  if (snapshot.merged) throw preconditionError(
    'PULL_REQUEST_ALREADY_MERGED',
    `Cannot ${action} ${name}: the pull request was already merged.`,
    'pullRequestOpen', snapshot,
    { details: { mergedAt: snapshot.mergedAt, mergeCommitSha: snapshot.mergeCommitSha } },
  );
  if (snapshot.state === 'closed') throw preconditionError(
    'PULL_REQUEST_CLOSED',
    `Cannot ${action} ${name}: the pull request is closed.`,
    'pullRequestOpen', snapshot,
    { details: { closedAt: snapshot.closedAt } },
  );
}

function assertNotDraft(pr: PullRequestStateSource, snapshot: PullRequestSnapshot): void {
  if (snapshot.draft) throw preconditionError(
    'PULL_REQUEST_DRAFT',
    `Cannot merge ${pullRequestName(pr)}: the pull request is still a draft. Mark it ready for review before merging.`,
    'notDraft', snapshot,
  );
}

/** Require an open pull request. Merging additionally rejects drafts; other mutations continue to allow them. */
export function assertPullRequestOpen(pr: PullRequestStateSource, action: string): void {
  const snapshot = pullRequestSnapshot(pr);
  assertOpenState(pr, action, snapshot);
  if (action === 'merge') assertNotDraft(pr, snapshot);
}

/** Preserve optimistic head checks for every mutation while giving them a stable precondition stage. */
export function assertPullRequestHead(pr: PullRequestStateSource, expectedHead?: string): void {
  const currentHead = head(pr);
  if (expectedHead && currentHead !== expectedHead) throw new McpError('STALE_HEAD', 'Pull request head changed. Read it again.', 409, {
    stage: 'precondition', details: { expectedHead, currentHead },
  });
}

function namedChecks(kind: 'failing' | 'pending', snapshot: PullRequestSnapshot): string {
  const names = snapshot.checks[kind];
  const noun = names.length === 1 ? 'check is' : 'checks are';
  const state = kind === 'failing' ? 'failing' : 'still running';
  return names.length ? `${names.length} required ${noun} ${state} (${names.join(', ')})` : `required checks are ${state}`;
}

/** Evaluate merge guards in their public, deterministic order and return the snapshot used for the decision. */
export function assertMergePreconditions(
  pr: PullRequestStateSource,
  graph: PullRequestStateSource,
  expectedHead: string,
): PullRequestSnapshot {
  const snapshot = pullRequestSnapshot(pr, graph);
  assertOpenState(pr, 'merge', snapshot);
  const name = pullRequestName(pr);
  if (snapshot.head !== expectedHead) throw preconditionError(
    'STALE_HEAD',
    `Cannot merge ${name}: the pull request head changed from ${expectedHead} to ${snapshot.head ?? 'an unknown revision'}. Read it again.`,
    'headMatchesExpected', snapshot,
    { details: { expectedHead, currentHead: snapshot.head } },
  );
  // Draft is the second ordered merge guard, so it deliberately follows the head check.
  assertNotDraft(pr, snapshot);
  if (snapshot.reviewDecision === 'CHANGES_REQUESTED') throw preconditionError(
    'CHANGES_REQUESTED',
    `Cannot merge ${name}: changes have been requested. Resolve them before merging.`,
    'noChangesRequested', snapshot,
  );
  if (snapshot.reviewDecision === 'REVIEW_REQUIRED') throw preconditionError(
    'REVIEW_REQUIRED',
    `Cannot merge ${name}: a required review is still missing. Obtain the required approval before merging.`,
    'reviewsSatisfied', snapshot,
  );
  if (snapshot.checks.state && FAILURE_STATES.has(snapshot.checks.state)) throw preconditionError(
    'CHECKS_FAILING',
    `Cannot merge ${name}: ${namedChecks('failing', snapshot)}. Fix them before merging.`,
    'checksPassing', snapshot,
    { details: { failing: [...snapshot.checks.failing] } },
  );
  if (snapshot.checks.state && PENDING_STATES.has(snapshot.checks.state)) throw preconditionError(
    'CHECKS_PENDING',
    `Cannot merge ${name}: ${namedChecks('pending', snapshot)}. Try again when they finish.`,
    'checksComplete', snapshot,
    { retryable: true, details: { pending: [...snapshot.checks.pending] } },
  );
  if (snapshot.mergeStateStatus === 'BEHIND') throw preconditionError(
    'BRANCH_BEHIND_BASE',
    `Cannot merge ${name}: the branch is behind ${snapshot.base ?? 'its base branch'}. Use update_pull_request_branch, then wait for checks to finish.`,
    'branchUpToDate', snapshot,
  );
  if (snapshot.mergeStateStatus === 'DIRTY') throw preconditionError(
    'MERGE_CONFLICT', `Cannot merge ${name}: the branch has merge conflicts with ${snapshot.base ?? 'its base branch'}.`,
    'mergeable', snapshot,
  );
  if (snapshot.mergeStateStatus === 'BLOCKED') throw preconditionError(
    'BRANCH_PROTECTION_BLOCKED', `Cannot merge ${name}: branch protection requirements are blocking the merge.`,
    'branchProtectionSatisfied', snapshot,
  );
  if (snapshot.mergeStateStatus === 'UNKNOWN') throw preconditionError(
    'MERGE_STATE_UNKNOWN', `Cannot merge ${name}: GitHub is still computing the merge state. Try again shortly.`,
    'mergeStateKnown', snapshot, { retryable: true },
  );
  if (['UNSTABLE', 'HAS_HOOKS'].includes(snapshot.mergeStateStatus ?? '') && snapshot.checks.state !== 'SUCCESS') {
    throw preconditionError(
      'CHECKS_FAILING', `Cannot merge ${name}: ${namedChecks('failing', snapshot)}. Fix them before merging.`,
      'checksPassing', snapshot, { details: { failing: [...snapshot.checks.failing] } },
    );
  }
  return snapshot;
}

/** Convert GitHub's definitive refusal into the same durable precondition envelope. */
export function mergeRejectedError(
  pr: PullRequestStateSource,
  graph: PullRequestStateSource,
  githubMessage: string | null | undefined,
): McpError {
  const snapshot = pullRequestSnapshot(pr, graph);
  const message = githubMessage?.trim() || 'GitHub rejected the merge.';
  return preconditionError('MERGE_REJECTED', `Cannot merge ${pullRequestName(pr)}: ${message}`, 'githubMergeAccepted', snapshot, {
    details: { githubMessage: message },
  });
}
