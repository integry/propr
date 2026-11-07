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

/** Workflow and action definitions: a change there is what GitHub's maintainer approval gate exists for. */
const CI_CONFIGURATION_PATH = /^\.github\/(?:workflows|actions)\//;

/** Changed paths of a pull request that define CI, read across every page GitHub serves (it caps a PR at 3000 files). */
async function changedCiConfiguration(
  principal: Principal, owner: string, repo: string, pullNumber: number,
): Promise<string[]> {
  const paths: string[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const { data } = await principal.github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', { owner, repo, pull_number: pullNumber, per_page: 100, page });
    for (const file of data) {
      if (CI_CONFIGURATION_PATH.test(file.filename) || (file.previous_filename && CI_CONFIGURATION_PATH.test(file.previous_filename))) paths.push(file.filename);
    }
    if (data.length < 100) return paths;
  }
  throw new McpError('GITHUB_RESPONSE_INVALID', 'The pull request changes more files than can be read, so its CI configuration cannot be checked.', 502, { stage: 'github', retryable: true });
}

export interface PullRequestTriageContext {
  /** Fields shared by PR mutations whose expectedHead is optional. */
  appendOnlyMutation: z.ZodRawShape;
  /** Fields shared by PR mutations that require expectedHead. */
  mutation: z.ZodRawShape;
  /** Reads the pull request before any write. */
  pull: (principal: Principal, args: Record<string, any>) => Promise<{ owner: string; repo: string; pr: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Acting-step PR triage: relabel a PR, close one that should not proceed, or let a fork's CI run. */
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
  tools.push({ name: 'approve_pull_request_workflow_runs', description: 'Approve the GitHub Actions runs of an open PR that wait for a maintainer, which is how CI starts for a fork or a first-time contributor. Approve only after reading the whole diff: the runs execute the PR\'s code on the repository\'s runners. expectedHead is required so only the revision you examined is approved; a moved head fails with STALE_HEAD. A PR that changes workflow or action definitions under .github is refused with CI_CONFIGURATION_CHANGED and must be approved by a person in GitHub. Returns the runs approved; an empty list means nothing was waiting on that head.', scope: 'execute',
    schema: z.object({ ...mutation }).strict(), run: async ({ principal, args }) => {
      const { owner, repo, pr } = await pull(principal, args);
      assertPullRequestOpen(pr, 'approve workflow runs for');
      assertPullRequestHead(pr, args.expectedHead);
      const ciPaths = await changedCiConfiguration(principal, owner, repo, args.pullRequest);
      if (ciPaths.length) {
        throw new McpError('CI_CONFIGURATION_CHANGED', `This pull request changes CI configuration (${ciPaths.join(', ')}); a person must approve its workflow runs in GitHub after reading them.`, 409, { stage: 'precondition', details: { paths: ciPaths } });
      }
      const waiting = (await principal.github.request('GET /repos/{owner}/{repo}/actions/runs', { owner, repo, head_sha: pr.head.sha, status: 'action_required', per_page: 100 })).data.workflow_runs;
      const approved: Array<{ id: number; name: string | null; url: string }> = [];
      for (const run of waiting) {
        try {
          await principal.github.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve', { owner, repo, run_id: run.id });
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status === 403) throw new McpError('ACTIONS_WRITE_REQUIRED', 'GitHub refused the approval: the credential lacks write access to Actions on this repository.', 403, { stage: 'github', details: { approved } });
          // No longer waiting: somebody approved it meanwhile, or the run ended.
          if (status === 409) continue;
          throw error;
        }
        approved.push({ id: run.id, name: run.name ?? null, url: run.html_url });
      }
      return ok({ repository: args.repository, pullRequest: args.pullRequest, expectedHead: args.expectedHead, approved, url: pr.html_url });
    } });
}
