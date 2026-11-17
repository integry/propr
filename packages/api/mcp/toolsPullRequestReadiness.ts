import { z } from 'zod';
import { evaluatePullRequestReadiness } from '@propr/core';
import { McpError } from './config.js';
import { readinessFailure, readinessReviewScores } from '../routes/pullRequestReadinessRoutes.js';
import { type Args, type McpTool, type ToolDeps, repositorySchema, ok } from './tools.js';

/** Reads the pull request with the caller's GitHub access, which authorizes the repository. */
type PullReader = (principal: Parameters<McpTool['run']>[0]['principal'], args: Args) => Promise<{ owner: string; repo: string }>;

/**
 * get_pull_request_readiness. It predates the `pullRequest` name every other PR
 * tool uses, so it accepts both `pullRequest` and the original `number`.
 */
export function pullRequestReadinessTool(deps: ToolDeps, pull: PullReader): McpTool {
  return { name: 'get_pull_request_readiness', description: 'Read-only verdict of whether a PR is ready to integrate: ready, waiting, blocked, merged, closed or unknown, with each gate (open, not_draft, checks, mergeable, human_review, ai_review, ultrafix, active_work, policy), its status and stable reason code, plus blockingReasons and waitingReasons. Evaluated with the ProPR App identity from the signals auto-merge uses. Never writes to GitHub, updates the branch, merges or changes auto-merge. Name the pull request with pullRequest; number is accepted as an alias.', scope: 'read', readOnly: true,
    schema: z.object({ repository: repositorySchema, pullRequest: z.number().int().positive().optional().describe('Pull request number, as every other pull request tool names it.'),
      number: z.number().int().positive().optional().describe('Same as pullRequest; kept for existing callers.') }).strict(),
    validate: args => {
      if (args.pullRequest !== undefined && args.number !== undefined && args.pullRequest !== args.number) throw new McpError('INVALID_INPUT', 'pullRequest and number name different pull requests; pass only pullRequest.', 400, { stage: 'validation' });
      if (args.pullRequest === undefined && args.number === undefined) throw new McpError('INVALID_INPUT', 'Provide the pull request number as pullRequest.', 400, { stage: 'validation' });
    },
    run: async ({ principal, args }) => {
      const number = args.pullRequest ?? args.number;
      // The caller's own read authorizes the repository, as get_pull_request does; the evaluation then uses the App identity.
      const { owner, repo } = await pull(principal, { repository: args.repository, pullRequest: number });
      try {
        return ok(await (deps.pullRequestReadiness ?? evaluatePullRequestReadiness)(owner, repo, number, { loadReviewScores: readinessReviewScores(deps.db) }));
      } catch (error) {
        const failure = readinessFailure(error);
        throw new McpError(failure.code, failure.message, failure.status, { stage: 'github', retryable: failure.status !== 404 });
      }
  } };
}
