import type { IssueCommentEvent } from '@octokit/webhooks-types';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import type { DeliveryDisposition } from '../../intake/routingWebSocketProtocol.js';
import logger from '../../utils/logger.js';
import { authorizeSplitRequester } from './authorization.js';
import { parseSplitCommand } from './command.js';
import {
  createOrGetPrSplitOperation,
  type CreatePrSplitOperationInput,
  type CreatePrSplitOperationResult,
  type PrSplitOperation,
} from './operationStore.js';

type AuthenticatedOctokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

export interface PrSplitIntakeDependencies {
  getOctokit: typeof getAuthenticatedOctokit;
  authorizeRequester: typeof authorizeSplitRequester;
  createOperation: (input: CreatePrSplitOperationInput) => Promise<CreatePrSplitOperationResult>;
}

export type PrSplitIntakeResult =
  | { handled: false }
  | {
      handled: true;
      disposition: DeliveryDisposition;
      outcome: 'queued' | 'duplicate' | 'active' | 'unauthorized';
      operation?: PrSplitOperation;
    };

const DEFAULT_DEPENDENCIES: PrSplitIntakeDependencies = {
  getOctokit: getAuthenticatedOctokit,
  authorizeRequester: authorizeSplitRequester,
  createOperation: createOrGetPrSplitOperation,
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
  issueNumber: number;
  body: string;
}

async function postComment(octokit: AuthenticatedOctokit, options: PostCommentOptions): Promise<void> {
  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner: options.owner,
    repo: options.repo,
    issue_number: options.issueNumber,
    body: options.body,
  });
}

function operationResponse(result: CreatePrSplitOperationResult): string {
  const shortId = result.operation.id.slice(0, 8);

  if (result.outcome === 'created') {
    return `✅ Split operation \`${shortId}\` queued. The source PR branch will not be modified.`;
  }
  if (result.outcome === 'active') {
    return `⏳ Split operation \`${shortId}\` is already ${result.operation.status} for this PR. Wait for it to finish before requesting another split.`;
  }
  if (result.operation.status === 'completed' || result.operation.status === 'failed') {
    return `ℹ️ This split request already has operation \`${shortId}\` with status \`${result.operation.status}\`.`;
  }
  return `ℹ️ This split request is already ${result.operation.status} as operation \`${shortId}\`.`;
}

/**
 * Intake boundary for `issue_comment.created` `/split` commands.
 *
 * Returning `handled: true` tells the webhook dispatcher to stop before normal
 * plan/follow-up processing. This service only authorizes, snapshots metadata,
 * and persists queued state; it never touches the contributor's branch.
 */
export async function handlePrSplitComment(
  payload: IssueCommentEvent,
  correlationId: string,
  dependencies: PrSplitIntakeDependencies = DEFAULT_DEPENDENCIES,
): Promise<PrSplitIntakeResult> {
  if (payload.action !== 'created' || !payload.issue.pull_request) return { handled: false };

  const command = parseSplitCommand(payload.comment.body);
  if (!command) return { handled: false };

  const correlatedLogger = logger.withCorrelation(correlationId);
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const repository = payload.repository.full_name;
  const sourcePrNumber = payload.issue.number;
  const requester = payload.comment.user.login;
  const commentId = payload.comment.id;
  const octokit = await dependencies.getOctokit();

  const authorization = await dependencies.authorizeRequester(octokit, {
    owner,
    repo,
    username: requester,
  });

  if (!authorization.authorized) {
    await postComment(octokit, {
      owner,
      repo,
      issueNumber: sourcePrNumber,
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

  const { data: pullRequest } = await octokit.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    { owner, repo, pull_number: sourcePrNumber },
  );

  const result = await dependencies.createOperation({
    repository,
    sourcePrNumber,
    baseRef: pullRequest.base.ref,
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
    requester,
    originalCommentId: commentId,
    instruction: command.instruction,
  });

  await postComment(octokit, {
    owner,
    repo,
    issueNumber: sourcePrNumber,
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
