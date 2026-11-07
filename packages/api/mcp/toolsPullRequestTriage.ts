import { z } from 'zod';
import { McpError } from './config.js';
import { beforeSideEffects } from './errorEnvelope.js';
import { type McpTool, ok, textSchema } from './tools.js';
import { ULTRAFIX_LABEL, labelNames, managedModelLabels } from './pullRequestInventory.js';
import { assertPullRequestHead, assertPullRequestOpen } from './pullRequestPreconditions.js';

// GitHub caps a label name at 50 characters; the change count keeps one call to a handful of writes.
const labelSchema = z.string().trim().min(1).max(50);
const MAX_LABEL_CHANGES = 10;

type Principal = Parameters<McpTool['run']>[0]['principal'];

export interface PullRequestTriageContext {
  /** Fields shared by PR mutations whose expectedHead is optional. */
  appendOnlyMutation: z.ZodRawShape;
  /** Fields shared by PR mutations that require expectedHead. */
  mutation: z.ZodRawShape;
  /** Reads the pull request before any write. */
  pull: (principal: Principal, args: Record<string, any>) => Promise<{ owner: string; repo: string; pr: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Acting-step PR triage: relabel a PR or close one that should not proceed. */
export function addPullRequestTriageTools(tools: McpTool[], { appendOnlyMutation, mutation, pull }: PullRequestTriageContext): void {
  tools.push({ name: 'update_pull_request_labels', description: 'Add and/or remove plain labels on an open PR, for example the instance trigger label (see get_ai_primary_tag) that hands the PR to ProPR. Only labels the repository already defines are added; none are created. Managed labels are refused: llm-* belongs to set_pull_request_model and ultrafix to start_ultrafix/stop_ultrafix. expectedHead is optional; when omitted the current head at call time is used and returned as resolvedHead.', scope: 'execute',
    schema: z.object({ ...appendOnlyMutation, add: z.array(labelSchema).max(MAX_LABEL_CHANGES).default([]), remove: z.array(labelSchema).max(MAX_LABEL_CHANGES).default([]) }).strict(),
    run: async ({ principal, args }) => {
      const requested = [...args.add, ...args.remove];
      if (requested.length === 0) throw new McpError('INVALID_INPUT', 'Name at least one label to add or remove.');
      if (args.add.some((name: string) => args.remove.some((other: string) => other.toLowerCase() === name.toLowerCase()))) throw new McpError('INVALID_INPUT', 'A label cannot be both added and removed.');
      const managed = requested.filter(name => managedModelLabels([name]).length > 0 || name.toLowerCase() === ULTRAFIX_LABEL);
      if (managed.length > 0) throw new McpError('MANAGED_LABEL', `ProPR manages ${managed.join(', ')}: use set_pull_request_model for llm-* labels and start_ultrafix/stop_ultrafix for ${ULTRAFIX_LABEL}.`, 409);
      const { owner, repo, pr } = await pull(principal, args);
      const resolvedHead = pr.head.sha;
      const headSource = args.expectedHead ? 'caller' : 'server';
      assertPullRequestOpen(pr, 'relabel');
      assertPullRequestHead(pr, args.expectedHead);
      const current = labelNames(pr.labels);
      const has = (name: string) => current.some(existing => existing.toLowerCase() === name.toLowerCase());
      const additions = args.add.filter((name: string) => !has(name));
      const removals = current.filter(name => args.remove.some((other: string) => other.toLowerCase() === name.toLowerCase()));
      // GitHub would create an unknown label on the fly; ProPR never invents one.
      const undefinedLabels = await beforeSideEffects(async () => {
        const missing: string[] = [];
        for (const name of additions) {
          const defined = await principal.github.request('GET /repos/{owner}/{repo}/labels/{name}', { owner, repo, name })
            .then(() => true, (error: unknown) => { if ((error as { status?: number })?.status === 404) return false; throw error; });
          if (!defined) missing.push(name);
        }
        return missing;
      });
      if (undefinedLabels.length > 0) throw new McpError('LABEL_MISSING', `This repository defines no label named ${undefinedLabels.join(', ')}. Create it in GitHub first; ProPR will not invent one.`, 409);
      if (additions.length > 0) await principal.github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { owner, repo, issue_number: args.pullRequest, labels: additions });
      for (const name of removals) await principal.github.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { owner, repo, issue_number: args.pullRequest, name });
      return ok({ repository: args.repository, pullRequest: args.pullRequest, expectedHead: args.expectedHead, resolvedHead, headSource,
        previousLabels: current, addedLabels: additions, removedLabels: removals, labels: [...current.filter(name => !removals.includes(name)), ...additions], state: 'updated' });
    } });
  tools.push({ name: 'close_pull_request', description: 'Close an open PR without merging, for a submission that should not proceed at all: a duplicate, out of scope, invalid or harmful. The reason is posted as a comment first, so the submitter sees why. expectedHead is required so only the revision you examined is closed; a moved head fails with STALE_HEAD. Prefer comment_on_pull_request when the submitter could fix the PR. The branch is kept and the PR can be reopened in GitHub.', scope: 'execute',
    schema: z.object({ ...mutation, reason: textSchema }).strict(), run: async ({ principal, args, operationId }) => {
      const { owner, repo, pr } = await pull(principal, args);
      assertPullRequestOpen(pr, 'close');
      assertPullRequestHead(pr, args.expectedHead);
      const body = `${args.reason}\n\n<!-- propr-mcp:${operationId}; head:${pr.head.sha}; action:close -->`;
      const comment = await principal.github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: args.pullRequest, body });
      const closed = await principal.github.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: args.pullRequest, state: 'closed' });
      return ok({ repository: args.repository, pullRequest: args.pullRequest, expectedHead: args.expectedHead, commentId: comment.data.id, commentUrl: comment.data.html_url,
        url: pr.html_url, state: closed.data.state === 'closed' ? 'closed' : 'open' });
    } });
}
