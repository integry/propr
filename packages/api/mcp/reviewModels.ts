import { z } from 'zod';
import { McpError } from './config.js';
import { classifyError } from './errorEnvelope.js';
import type { Args, McpTool } from './tools.js';
import { type ModelChoice, describeChoices, enabledModelChoices, matchEnabledModel } from './pullRequestInventory.js';
import { assertPullRequestHead, assertPullRequestOpen } from './pullRequestPreconditions.js';

/** Upper bound on one review fan-out: every listed model is an independent review run. */
export const MAX_REVIEW_MODELS = 8;
/** One model token on the `/review` command line, exactly as a hand-typed comment carries it. */
export const reviewModelSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9][\w.:~/@+-]*$/, 'A model alias is a single token without spaces.');

/**
 * `requested` is the caller's token, kept for the receipt; `command` is the token the
 * `/review` comment carries, with the managed `llm-` prefix removed the same
 * case-insensitive way validation removed it, so the review runs the validated model.
 */
interface ReviewModelChoice extends ModelChoice { requested: string; command: string }

/**
 * Resolve every requested reviewing model against the enabled agents `list_models`
 * exposes before anything is posted. A model that resolves to no enabled choice, or
 * to a choice another entry already requested, is named in the error rather than
 * dropped or replaced by a fallback, and no review is requested at all.
 */
export async function resolveReviewModels(requested: string[]): Promise<ReviewModelChoice[]> {
  const choices = await enabledModelChoices();
  const resolved: ReviewModelChoice[] = [];
  const rejected: Array<{ model: string; code: string; message: string }> = [];
  const claimed = new Map<string, string>();
  for (const alias of requested) {
    const match = await matchEnabledModel(alias, choices);
    if (!match) {
      rejected.push({ model: alias, code: 'UNKNOWN_MODEL', message: `Model “${alias}” does not resolve to an enabled agent model.` });
      continue;
    }
    const key = `${match.agentAlias}:${match.model}`.toLowerCase();
    const first = claimed.get(key);
    if (first !== undefined) {
      rejected.push({ model: alias, code: 'DUPLICATE_MODEL', message: `Model “${alias}” resolves to ${match.agentAlias}:${match.model}, which “${first}” already requested.` });
      continue;
    }
    claimed.set(key, alias);
    resolved.push({ requested: alias, command: alias.replace(/^llm-/i, ''), ...match });
  }
  if (rejected.length) {
    throw new McpError(rejected.some(entry => entry.code === 'UNKNOWN_MODEL') ? 'UNKNOWN_MODEL' : 'DUPLICATE_MODEL',
      `No review was requested. ${rejected.map(entry => entry.message).join(' ')} Valid choices: ${describeChoices(choices)}.`,
      400, { stage: 'validation', details: { rejectedModels: rejected } });
  }
  return resolved;
}

/**
 * Post one `/review <model>` comment per resolved model, each its own independent
 * review run, exactly as separate hand-typed comments would be. Every review after
 * the first re-reads the pull request and must still find it open at the head the
 * first one was pinned to; once that guard fails, the remaining models are reported
 * as not posted instead of reviewing a head the caller has not seen. A comment that
 * fails to post after an earlier one succeeded is reported as rejected or unknown,
 * and the rest as not posted, so the confirmed receipts are returned. No label is
 * read or written, so the pull request's model routing is left untouched.
 */
export async function postModelReviews(
  principal: Parameters<McpTool['run']>[0]['principal'], args: Args,
  context: { owner: string; repo: string; resolvedHead: string; headSource: string; operationId?: string },
  models: ReviewModelChoice[],
): Promise<Record<string, unknown>[]> {
  const { owner, repo, resolvedHead, headSource, operationId } = context;
  const reviews: Record<string, unknown>[] = [];
  let blocked: { code: string; message: string; details?: Record<string, unknown> } | null = null;
  for (const [index, choice] of models.entries()) {
    const receipt = { model: choice.requested, agentAlias: choice.agentAlias, resolvedModel: choice.model, expectedHead: args.expectedHead };
    if (index > 0 && !blocked) {
      try {
        const { data: current } = await principal.github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: args.pullRequest });
        assertPullRequestOpen(current, 'run review on');
        assertPullRequestHead(current, resolvedHead);
      } catch (error) {
        blocked = error instanceof McpError
          ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
          : { code: 'GITHUB_READ_FAILED', message: 'The pull request could not be read again before this review, so it was not requested.' };
      }
    }
    if (blocked) {
      reviews.push({ ...receipt, resolvedHead, headSource, state: 'not_posted', error: blocked });
      continue;
    }
    const body = `/review ${choice.command}${args.instructions ? `\n\n${args.instructions}` : ''}\n\n<!-- propr-mcp:${operationId}; head:${resolvedHead} -->`;
    let data: { id: number; html_url: string };
    try {
      ({ data } = await principal.github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: args.pullRequest, body }));
    } catch (error) {
      // With nothing posted yet the failure is the whole call's outcome. Once a
      // review is posted its receipt must survive, so the failed model is recorded
      // instead: a GitHub rejection definitely posted nothing, any other failure may
      // have, and is never retried here. The remaining models are not attempted.
      if (!reviews.some(review => review.state === 'posted')) throw error;
      const known = classifyError(error, { sideEffectsPossible: false });
      const rejected = known.stage === 'github' && known.status >= 400 && known.status < 500;
      reviews.push({ ...receipt, resolvedHead, headSource, state: rejected ? 'rejected' : 'unknown',
        error: rejected ? known : classifyError(error, { sideEffectsPossible: true }) });
      blocked = { code: 'PREVIOUS_REVIEW_NOT_POSTED', message: `The review for “${choice.requested}” could not be confirmed as posted, so no further review was requested.` };
      continue;
    }
    reviews.push({ ...receipt, commentId: data.id, url: data.html_url, resolvedHead, headSource, state: 'posted' });
  }
  return reviews;
}
