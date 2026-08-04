import type { IssueCommentEvent } from '@octokit/webhooks-types';
import type { Knex } from 'knex';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import type { DeliveryDisposition } from '../../intake/routingWebSocketProtocol.js';
import logger from '../../utils/logger.js';
import {
  authorizeSplitRequester,
  type PrSplitRequestClient,
  type SplitAuthorizationRequest,
  type SplitAuthorizationResult,
} from './authorization.js';
import {
  claimPrSplitCommandResponse,
  createOrGetPrSplitOperation,
  getPrSplitCommandRecord,
  markPrSplitCommandResponsePosted,
  recordPrSplitCommandOutcome,
  releasePrSplitCommandResponseClaim,
  reservePrSplitCommand,
  type PrSplitCommandInput,
  type PrSplitCommandOutcome,
  type PrSplitCommandRecord,
} from './commandStore.js';
import { MAX_SPLIT_INSTRUCTION_LENGTH, parseSplitCommand } from './command.js';
import type { PrSplitOperation } from './operationStore.js';

export interface PrSplitIntakeDependencies {
  getOctokit: () => Promise<PrSplitRequestClient>;
  authorizeRequester: (
    client: PrSplitRequestClient,
    request: SplitAuthorizationRequest,
  ) => Promise<SplitAuthorizationResult>;
  isExecutionEnabled: () => boolean;
  getResponseAuthorLogin: () => string | undefined;
  db?: Knex;
}

export type PrSplitIntakeResult =
  | { handled: false }
  | {
      handled: true;
      disposition: DeliveryDisposition;
      outcome: PrSplitCommandOutcome;
      operation?: PrSplitOperation;
    };

export function isPrSplitExecutionEnabled(
  value = process.env.PR_SPLIT_EXECUTION_ENABLED,
): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

async function getDefaultOctokit(): Promise<PrSplitRequestClient> {
  return getAuthenticatedOctokit();
}

const DEFAULT_DEPENDENCIES: PrSplitIntakeDependencies = {
  getOctokit: getDefaultOctokit,
  authorizeRequester: authorizeSplitRequester,
  isExecutionEnabled: isPrSplitExecutionEnabled,
  getResponseAuthorLogin: () => process.env.GITHUB_BOT_USERNAME?.trim() || undefined,
};

const BLOCKED_OUTCOME_REASONS: Partial<Record<PrSplitCommandOutcome, string>> = {
  disabled: 'split_execution_not_enabled',
  unauthorized: 'insufficient_repository_permission',
  active: 'split_operation_already_active',
  closed: 'split_pull_request_closed',
  invalid: 'split_instruction_too_long',
  rate_limited: 'split_request_rate_limited',
};

function acceptedDisposition(commentId: number): DeliveryDisposition {
  return {
    status: 'accepted',
    billing: { seatConsumed: false },
    evidence: { triggerCommentIds: [commentId] },
  };
}

function blockedDisposition(reason: string): DeliveryDisposition {
  return {
    status: 'blocked',
    reason,
    billing: { seatConsumed: false },
  };
}

function dispositionFor(record: PrSplitCommandRecord): DeliveryDisposition {
  const reason = BLOCKED_OUTCOME_REASONS[record.receipt.outcome as PrSplitCommandOutcome];
  return reason
    ? blockedDisposition(reason)
    : acceptedDisposition(record.receipt.original_comment_id);
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function shortOperationId(record: PrSplitCommandRecord): string {
  return record.receipt.operation_id?.slice(0, 8) ?? 'unknown';
}

function responseBody(record: PrSplitCommandRecord): string {
  const shortId = shortOperationId(record);

  switch (record.receipt.outcome) {
    case 'disabled':
      return '⏸️ `/split` is not available because split execution workers are not enabled for this deployment.';
    case 'unauthorized':
      return '⛔ `/split` requires `write`, `maintain`, or `admin` permission on this repository.';
    case 'closed':
      return '⛔ `/split` can only run on an open, unmerged pull request.';
    case 'invalid':
      return `⛔ \`/split\` instructions are limited to ${MAX_SPLIT_INSTRUCTION_LENGTH.toLocaleString('en-US')} characters.`;
    case 'rate_limited':
      return '⏳ Too many `/split` commands were received from this account. Try again later.';
    case 'queued':
      return `✅ Split operation \`${shortId}\` queued. The source PR branch will not be modified.`;
    case 'active':
      return `⏳ Split operation \`${shortId}\` already owned this PR when the command was recorded. Wait for it to finish before requesting another split.`;
    case 'duplicate':
      return `ℹ️ Equivalent split operation \`${shortId}\` was already recorded for this PR.`;
    default:
      throw new Error(`Unsupported PR split command outcome: ${record.receipt.outcome}`);
  }
}

interface PostResponseContext {
  owner: string;
  repo: string;
  responseAuthorLogin?: string;
  getOctokit: () => Promise<PrSplitRequestClient>;
  octokit?: PrSplitRequestClient;
  db?: Knex;
}

const RESPONSE_RECONCILIATION_PAGE_SIZE = 100;
const RESPONSE_RECONCILIATION_SAFETY_MARGIN_MS = 60_000;

function responseMarker(eventKey: string): string {
  return `<!-- propr:pr-split-response:${eventKey} -->`;
}

function githubErrorStatus(error: unknown): number | null {
  return isRecord(error) && typeof error.status === 'number' ? error.status : null;
}

function isDefinitiveGitHubRejection(error: unknown): boolean {
  const status = githubErrorStatus(error);
  return status !== null && status >= 400 && status < 500;
}

async function findPostedResponse(
  record: PrSplitCommandRecord,
  context: PostResponseContext,
  octokit: PrSplitRequestClient,
): Promise<number | null | undefined> {
  const marker = responseMarker(record.receipt.event_key);
  let responseAuthorLogin = context.responseAuthorLogin;
  if (!responseAuthorLogin) {
    const { data } = await octokit.request('GET /installation', {});
    if (!isRecord(data) || typeof data.app_slug !== 'string') {
      throw new Error('GitHub installation response did not include an App slug');
    }
    responseAuthorLogin = `${data.app_slug}[bot]`;
  }
  const since = new Date(
    new Date(record.receipt.created_at).getTime() - RESPONSE_RECONCILIATION_SAFETY_MARGIN_MS,
  ).toISOString();
  for (let page = 1; ; page += 1) {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {
        owner: context.owner,
        repo: context.repo,
        issue_number: record.receipt.source_pr_number,
        since,
        per_page: RESPONSE_RECONCILIATION_PAGE_SIZE,
        page,
      },
    );
    if (!Array.isArray(data)) {
      throw new Error('GitHub issue comments response was not an array');
    }
    const response = data.find((comment) => {
      if (!isRecord(comment) || typeof comment.body !== 'string') return false;
      const user = comment.user;
      return comment.body.includes(marker)
        && isRecord(user)
        && user.type === 'Bot'
        && typeof user.login === 'string'
        && user.login.toLowerCase() === responseAuthorLogin.toLowerCase();
    });
    if (isRecord(response)) return typeof response.id === 'number' ? response.id : null;
    if (data.length < RESPONSE_RECONCILIATION_PAGE_SIZE) return undefined;
  }
}

async function markResponsePosted(
  record: PrSplitCommandRecord,
  claimToken: string,
  responseCommentId: number | null,
  db?: Knex,
): Promise<void> {
  const marked = await markPrSplitCommandResponsePosted(
    record.receipt.event_key,
    claimToken,
    responseCommentId,
    db,
  );
  if (!marked) throw new Error(`Lost PR split response claim for ${record.receipt.event_key}`);
}

async function postResponseOnce(
  record: PrSplitCommandRecord,
  context: PostResponseContext,
): Promise<boolean> {
  const eventKey = record.receipt.event_key;
  if (record.receipt.response_state === 'posted'
    || record.receipt.response_state === 'suppressed') return false;
  const claim = await claimPrSplitCommandResponse(eventKey, context.db);
  if (!claim) {
    const refreshed = await getPrSplitCommandRecord({
      repositoryId: record.receipt.repository_id,
      originalCommentId: record.receipt.original_comment_id,
    }, context.db);
    if (refreshed?.receipt.response_state === 'posted'
      || refreshed?.receipt.response_state === 'suppressed') return false;
    throw new Error(`PR split response claim for ${eventKey} is still live; retry delivery`);
  }

  let octokit = context.octokit;
  try {
    octokit ??= await context.getOctokit();
  } catch (error) {
    if (!claim.needsReconciliation) {
      await releasePrSplitCommandResponseClaim(eventKey, claim.token, context.db);
    }
    throw error;
  }

  if (claim.needsReconciliation) {
    const responseCommentId = await findPostedResponse(record, context, octokit);
    if (responseCommentId !== undefined) {
      await markResponsePosted(record, claim.token, responseCommentId, context.db);
      return true;
    }
  }

  let data: unknown;
  try {
    ({ data } = await octokit.request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {
        owner: context.owner,
        repo: context.repo,
        issue_number: record.receipt.source_pr_number,
        body: `${responseBody(record)}\n\n${responseMarker(eventKey)}`,
      },
    ));
  } catch (error) {
    if (isDefinitiveGitHubRejection(error)) {
      await releasePrSplitCommandResponseClaim(eventKey, claim.token, context.db);
    }
    throw error;
  }
  const responseCommentId = isRecord(data) && typeof data.id === 'number' ? data.id : null;
  await markResponsePosted(record, claim.token, responseCommentId, context.db);
  return true;
}

interface PullRequestSnapshot {
  baseRef: string;
  baseSha: string;
  headSha: string;
  state: 'open' | 'closed';
  merged: boolean;
}

function parsePullRequestSnapshot(data: unknown): PullRequestSnapshot {
  if (!isRecord(data) || !isRecord(data.base) || !isRecord(data.head)) {
    throw new Error('GitHub pull request response did not include base/head metadata');
  }
  const { ref, sha: baseSha } = data.base;
  const headSha = data.head.sha;
  const state = data.state;
  const merged = data.merged;
  if (
    typeof ref !== 'string'
    || typeof baseSha !== 'string'
    || typeof headSha !== 'string'
    || (state !== 'open' && state !== 'closed')
    || typeof merged !== 'boolean'
  ) {
    throw new Error('GitHub pull request response contained invalid snapshot metadata');
  }
  return { baseRef: ref, baseSha, headSha, state, merged };
}

interface IntakeContext {
  owner: string;
  repo: string;
  baseInput: PrSplitCommandInput;
  dependencies: PrSplitIntakeDependencies;
  correlationId: string;
}

async function finishIntake(
  record: PrSplitCommandRecord,
  context: IntakeContext,
  existingOctokit?: PrSplitRequestClient,
): Promise<PrSplitIntakeResult> {
  if (record.receipt.outcome === 'processing') {
    throw new Error(`PR split command ${record.receipt.event_key} is still processing`);
  }
  const responsePosted = await postResponseOnce(record, {
    owner: context.owner,
    repo: context.repo,
    responseAuthorLogin: context.dependencies.getResponseAuthorLogin()?.trim() || undefined,
    getOctokit: context.dependencies.getOctokit,
    ...(existingOctokit ? { octokit: existingOctokit } : {}),
    db: context.dependencies.db,
  });
  logger.withCorrelation(context.correlationId).info({
    repositoryId: record.receipt.repository_id,
    repository: record.receipt.repository,
    sourcePrNumber: record.receipt.source_pr_number,
    requesterId: record.receipt.requester_id,
    requester: record.receipt.requester,
    commentId: record.receipt.original_comment_id,
    operationId: record.receipt.operation_id,
    outcome: record.receipt.outcome,
    replayed: record.replayed,
    responsePosted,
  }, 'Handled /split command');

  return {
    handled: true,
    disposition: dispositionFor(record),
    outcome: record.receipt.outcome,
    ...(record.operation ? { operation: record.operation } : {}),
  };
}

/**
 * Durable intake boundary for `issue_comment.created` `/split` commands.
 * Every recognized command receives one immutable disposition before response.
 */
export async function handlePrSplitComment(
  payload: IssueCommentEvent,
  correlationId: string,
  dependencyOverrides: Partial<PrSplitIntakeDependencies> = {},
): Promise<PrSplitIntakeResult> {
  if (payload.action !== 'created' || !payload.issue.pull_request) return { handled: false };

  const command = parseSplitCommand(payload.comment.body);
  if (!command) return { handled: false };
  if (!payload.comment.user) throw new Error('GitHub split comment did not include a user');

  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const baseInput: PrSplitCommandInput = {
    repositoryId: payload.repository.id,
    repository: payload.repository.full_name,
    sourcePrNumber: payload.issue.number,
    requesterId: payload.comment.user.id,
    requester: payload.comment.user.login,
    originalCommentId: payload.comment.id,
    instruction: command.instruction,
  };
  const context: IntakeContext = { owner, repo, baseInput, dependencies, correlationId };
  const reservation = await reservePrSplitCommand(baseInput, dependencies.db);
  if (reservation.receipt.outcome !== 'processing') {
    return finishIntake(reservation, context);
  }

  if (command.validationError) {
    const record = await recordPrSplitCommandOutcome(
      { ...baseInput, outcome: 'invalid' },
      dependencies.db,
    );
    return finishIntake(record, context);
  }

  if (!dependencies.isExecutionEnabled()) {
    const record = await recordPrSplitCommandOutcome(
      { ...baseInput, outcome: 'disabled' },
      dependencies.db,
    );
    return finishIntake(record, context);
  }

  const octokit = await dependencies.getOctokit();
  const authorization = await dependencies.authorizeRequester(octokit, {
    owner,
    repo,
    username: baseInput.requester,
    requesterId: baseInput.requesterId,
  });
  if (!authorization.authorized) {
    const record = await recordPrSplitCommandOutcome(
      { ...baseInput, outcome: 'unauthorized' },
      dependencies.db,
    );
    return finishIntake(record, context, octokit);
  }

  const { data } = await octokit.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    { owner, repo, pull_number: baseInput.sourcePrNumber },
  );
  const pullRequest = parsePullRequestSnapshot(data);
  if (pullRequest.state !== 'open' || pullRequest.merged) {
    const record = await recordPrSplitCommandOutcome(
      { ...baseInput, outcome: 'closed' },
      dependencies.db,
    );
    return finishIntake(record, context, octokit);
  }

  const record = await createOrGetPrSplitOperation({
    ...baseInput,
    baseRef: pullRequest.baseRef,
    baseSha: pullRequest.baseSha,
    headSha: pullRequest.headSha,
  }, dependencies.db);
  return finishIntake(record, context, octokit);
}
