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
};

const BLOCKED_OUTCOME_REASONS: Partial<Record<PrSplitCommandOutcome, string>> = {
  disabled: 'split_execution_not_enabled',
  unauthorized: 'insufficient_repository_permission',
  active: 'split_operation_already_active',
  closed: 'split_pull_request_closed',
  invalid: 'split_instruction_too_long',
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
  octokit: PrSplitRequestClient;
  db?: Knex;
}

/**
 * The durable pending-to-claimed update is the sole authority to call GitHub.
 * A claim is intentionally never released: an ambiguous POST failure may lose
 * an acknowledgement, but can never create two conflicting visible responses.
 */
async function postResponseOnce(
  record: PrSplitCommandRecord,
  context: PostResponseContext,
): Promise<boolean> {
  const eventKey = record.receipt.event_key;
  const claimToken = await claimPrSplitCommandResponse(eventKey, context.db);
  if (!claimToken) return false;

  const marker = `<!-- propr:pr-split-response:${eventKey} -->`;
  const { data } = await context.octokit.request(
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    {
      owner: context.owner,
      repo: context.repo,
      issue_number: record.receipt.source_pr_number,
      body: `${responseBody(record)}\n\n${marker}`,
    },
  );
  const responseCommentId = isRecord(data) && typeof data.id === 'number' ? data.id : null;
  const marked = await markPrSplitCommandResponsePosted(
    eventKey,
    claimToken,
    responseCommentId,
    context.db,
  );
  if (!marked) throw new Error(`Lost PR split response claim for ${eventKey}`);
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
  const octokit = existingOctokit ?? await context.dependencies.getOctokit();
  const responsePosted = await postResponseOnce(record, {
    owner: context.owner,
    repo: context.repo,
    octokit,
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

  if (record.receipt.outcome === 'processing') {
    throw new Error(`PR split command ${record.receipt.event_key} is still processing`);
  }
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
  const eventIdentity = {
    repositoryId: baseInput.repositoryId,
    originalCommentId: baseInput.originalCommentId,
  };

  const existing = await getPrSplitCommandRecord(eventIdentity, dependencies.db);
  if (existing) return finishIntake(existing, context);

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
