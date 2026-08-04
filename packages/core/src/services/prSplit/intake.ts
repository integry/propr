import type { IssueCommentEvent } from '@octokit/webhooks-types';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import type { DeliveryDisposition } from '../../intake/routingWebSocketProtocol.js';
import logger from '../../utils/logger.js';
import {
  authorizeSplitRequester,
  type PrSplitRequestClient,
  type SplitAuthorizationRequest,
  type SplitAuthorizationResult,
} from './authorization.js';
import { parseSplitCommand } from './command.js';
import {
  buildSplitOperationEventKey,
  createOrGetPrSplitOperation,
  type CreatePrSplitOperationInput,
  type CreatePrSplitOperationResult,
  type PrSplitOperation,
} from './operationStore.js';

export interface PrSplitIntakeDependencies {
  getOctokit: () => Promise<PrSplitRequestClient>;
  authorizeRequester: (
    client: PrSplitRequestClient,
    request: SplitAuthorizationRequest,
  ) => Promise<SplitAuthorizationResult>;
  createOperation: (input: CreatePrSplitOperationInput) => Promise<CreatePrSplitOperationResult>;
  isExecutionEnabled: () => boolean;
}

export type PrSplitIntakeResult =
  | { handled: false }
  | {
      handled: true;
      disposition: DeliveryDisposition;
      outcome: 'queued' | 'duplicate' | 'active' | 'unauthorized' | 'disabled';
      operation?: PrSplitOperation;
    };

const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 100;

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
  createOperation: createOrGetPrSplitOperation,
  isExecutionEnabled: isPrSplitExecutionEnabled,
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

interface PostCommentOptions {
  owner: string;
  repo: string;
  repository: string;
  issueNumber: number;
  sourceCommentId: number;
  body: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function responseMarker(repository: string, sourceCommentId: number): string {
  const eventKey = buildSplitOperationEventKey({ repository, originalCommentId: sourceCommentId });
  return `<!-- propr:pr-split-response:${eventKey} -->`;
}

function commentHasMarker(comment: unknown, marker: string): boolean {
  if (!isRecord(comment) || !isRecord(comment.user)) return false;
  return comment.user.type === 'Bot'
    && typeof comment.body === 'string'
    && comment.body.includes(marker);
}

async function responseAlreadyExists(
  octokit: PrSplitRequestClient,
  options: PostCommentOptions,
  marker: string,
): Promise<boolean> {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {
        owner: options.owner,
        repo: options.repo,
        issue_number: options.issueNumber,
        per_page: COMMENT_PAGE_SIZE,
        page,
      },
    );
    if (!Array.isArray(data)) throw new Error('GitHub issue comments response was not an array');
    if (data.some((comment) => commentHasMarker(comment, marker))) return true;
    if (data.length < COMMENT_PAGE_SIZE) return false;
  }

  throw new Error('Unable to verify /split response marker after 100 comment pages');
}

/** Post at most one visible response for a source command across redeliveries. */
async function postCommentOnce(
  octokit: PrSplitRequestClient,
  options: PostCommentOptions,
): Promise<boolean> {
  const marker = responseMarker(options.repository, options.sourceCommentId);
  if (await responseAlreadyExists(octokit, options, marker)) return false;

  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner: options.owner,
    repo: options.repo,
    issue_number: options.issueNumber,
    body: `${options.body}\n\n${marker}`,
  });
  return true;
}

function operationResponse(result: CreatePrSplitOperationResult): string {
  const shortId = result.operation.id.slice(0, 8);

  if (result.outcome === 'created') {
    return `✅ Split operation \`${shortId}\` queued. The source PR branch will not be modified.`;
  }
  if (result.outcome === 'active') {
    return `⏳ Split operation \`${shortId}\` is already ${result.operation.status} for this PR. Wait for it to finish before requesting another split.`;
  }
  if (result.duplicateKind === 'event') {
    return `ℹ️ This command was already recorded as split operation \`${shortId}\` with status \`${result.operation.status}\`.`;
  }
  return `ℹ️ An equivalent split operation \`${shortId}\` already has status \`${result.operation.status}\`.`;
}

interface PullRequestSnapshot {
  baseRef: string;
  baseSha: string;
  headSha: string;
}

function parsePullRequestSnapshot(data: unknown): PullRequestSnapshot {
  if (!isRecord(data) || !isRecord(data.base) || !isRecord(data.head)) {
    throw new Error('GitHub pull request response did not include base/head metadata');
  }
  const { ref, sha: baseSha } = data.base;
  const headSha = data.head.sha;
  if (typeof ref !== 'string' || typeof baseSha !== 'string' || typeof headSha !== 'string') {
    throw new Error('GitHub pull request response contained invalid base/head metadata');
  }
  return { baseRef: ref, baseSha, headSha };
}

/**
 * Intake boundary for `issue_comment.created` `/split` commands.
 *
 * Returning `handled: true` tells the webhook dispatcher to stop before normal
 * plan/follow-up processing. Intake remains disabled by default until a split
 * execution consumer is deployed and `PR_SPLIT_EXECUTION_ENABLED=true` is set.
 */
export async function handlePrSplitComment(
  payload: IssueCommentEvent,
  correlationId: string,
  dependencyOverrides: Partial<PrSplitIntakeDependencies> = {},
): Promise<PrSplitIntakeResult> {
  if (payload.action !== 'created' || !payload.issue.pull_request) return { handled: false };

  const command = parseSplitCommand(payload.comment.body);
  if (!command) return { handled: false };

  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const correlatedLogger = logger.withCorrelation(correlationId);
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const repository = payload.repository.full_name;
  const sourcePrNumber = payload.issue.number;
  const requester = payload.comment.user.login;
  const commentId = payload.comment.id;
  const octokit = await dependencies.getOctokit();
  const responseOptions = {
    owner,
    repo,
    repository,
    issueNumber: sourcePrNumber,
    sourceCommentId: commentId,
  };

  if (!dependencies.isExecutionEnabled()) {
    await postCommentOnce(octokit, {
      ...responseOptions,
      body: '⏸️ `/split` is not available yet because split execution workers are not enabled for this deployment.',
    });
    correlatedLogger.info({ repository, sourcePrNumber, commentId }, 'Blocked staged /split command');
    return {
      handled: true,
      disposition: blockedDisposition('split_execution_not_enabled'),
      outcome: 'disabled',
    };
  }

  const authorization = await dependencies.authorizeRequester(octokit, {
    owner,
    repo,
    username: requester,
  });

  if (!authorization.authorized) {
    await postCommentOnce(octokit, {
      ...responseOptions,
      body: '⛔ `/split` requires `write`, `maintain`, or `admin` permission on this repository.',
    });
    correlatedLogger.warn(
      { repository, sourcePrNumber, requester, commentId, permission: authorization.permission },
      'Rejected unauthorized /split command',
    );
    return {
      handled: true,
      disposition: blockedDisposition('insufficient_repository_permission'),
      outcome: 'unauthorized',
    };
  }

  const { data } = await octokit.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    { owner, repo, pull_number: sourcePrNumber },
  );
  const pullRequest = parsePullRequestSnapshot(data);

  const result = await dependencies.createOperation({
    repository,
    sourcePrNumber,
    baseRef: pullRequest.baseRef,
    baseSha: pullRequest.baseSha,
    headSha: pullRequest.headSha,
    requester,
    originalCommentId: commentId,
    instruction: command.instruction,
  });

  const responsePosted = await postCommentOnce(octokit, {
    ...responseOptions,
    body: operationResponse(result),
  });
  correlatedLogger.info(
    {
      repository,
      sourcePrNumber,
      requester,
      commentId,
      operationId: result.operation.id,
      outcome: result.outcome,
      responsePosted,
    },
    'Handled /split command',
  );

  const outcome = result.outcome === 'created' ? 'queued' : result.outcome;
  return {
    handled: true,
    disposition: result.outcome === 'active'
      ? blockedDisposition('split_operation_already_active')
      : acceptedDisposition(commentId),
    outcome,
    operation: result.operation,
  };
}
