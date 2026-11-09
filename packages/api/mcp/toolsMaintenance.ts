import { z } from 'zod';
import {
  createDefaultFollowupHandoffDeps,
  followupHandoffTargetKey,
  type FollowupHandoffKey,
  type FollowupHandoffRouteDeps,
  type FollowupHandoffStatus,
} from '../routes/followupHandoffRoutes.js';
import { type McpTool, type ToolDeps, mutationShape, repositorySchema, ok } from './tools.js';
import { McpError } from './config.js';
import type { McpPrincipal } from './policy.js';

/**
 * Maintenance tools: the operator decisions that otherwise live only behind the
 * admin REST routes and the CLI. A follow-up handoff held for an operator blocks
 * every later command on its pull request, so an administrator must be able to
 * see and settle it from a chat client too. Same permission as the routes.
 */

const permission = 'instance.manage_runtime' as const;

/**
 * The admin routes' projection without the retained worktree's host path: MCP
 * results are redacted and a chat client has no use for a path on the worker.
 * The REST route and the CLI still name it for an operator on the host.
 */
function handoffPayload(status: FollowupHandoffStatus) {
  return {
    repository: status.record.repository,
    pullRequest: status.record.pull_request,
    taskId: status.record.task_id,
    predecessorTaskIds: status.predecessorTaskIds,
    successorTaskId: status.successorTaskId,
    phase: status.record.phase,
    status: status.record.status,
    statusReason: status.record.status_reason,
    settlement: status.record.settlement ?? null,
    operatorAuthorized: Boolean(status.record.operator_authorized),
    liveness: status.liveness,
    branchName: status.record.branch_name,
    commitHash: status.record.commit_hash,
    completionCommentUrl: status.record.completion_comment_url,
    nextAction: status.nextAction,
    retainedWorktree: Boolean(status.record.worktree_path),
    updatedAt: status.record.updated_at,
  };
}

function targetKey(args: { repository: string; pullRequest: number }): FollowupHandoffKey {
  const [owner, repo] = args.repository.split('/');
  const key = followupHandoffTargetKey({ owner, repo, pr: String(args.pullRequest) });
  if (!key) throw new McpError('INVALID_INPUT', 'Name the repository as owner/repo and the pull request by its number.');
  return key;
}

/**
 * The list takes no repository argument, so the shared executor's repository
 * check never runs for it. The instance permission authorizes the capability,
 * not the repositories: each record is shown only when the same read check the
 * keyed tools pass (grant, instance configuration, current GitHub access)
 * accepts its repository. Checked once per repository per call.
 */
function repositoryAccess(deps: ToolDeps, principal: McpPrincipal): (repository: string) => Promise<boolean> {
  const checked = new Map<string, Promise<boolean>>();
  return repository => {
    const key = repository.toLowerCase();
    if (!checked.has(key)) checked.set(key, deps.policy.repository(principal, repository).then(() => true, error => {
      if (error instanceof McpError && error.status === 403) return false;
      throw error;
    }));
    return checked.get(key)!;
  };
}

export function addMaintenanceTools(tools: McpTool[], deps: ToolDeps): void {
  // Built here, not at module load: tools.ts imports this module while its own schemas are still initializing.
  const targetShape = { repository: repositorySchema, pullRequest: z.number().int().min(1).max(9_999_999_999) };
  const handoffs: FollowupHandoffRouteDeps = deps.followupHandoffs ?? createDefaultFollowupHandoffDeps();
  const inspectOne = async (key: FollowupHandoffKey) => {
    const [status] = await handoffs.inspectFollowupHandoffs({}, key);
    if (!status) throw new McpError('NOT_FOUND', 'No follow-up handoff is tracked for that pull request.', 404);
    return handoffPayload(status);
  };

  tools.push({ name: 'list_followup_handoffs', description: 'List every tracked pull request follow-up handoff in the repositories this client may access: the attempts whose publication is still owed, including holds awaiting an operator that block new commands on their pull request. Requires instance.manage_runtime.', scope: 'manage', permission, readOnly: true, schema: z.object({}).strict(), run: async ({ principal }) => {
    const statuses = await handoffs.inspectFollowupHandoffs({});
    const visible = repositoryAccess(deps, principal);
    const allowed = await Promise.all(statuses.map(status => visible(status.record.repository)));
    return ok({ handoffs: statuses.filter((_status, index) => allowed[index]).map(handoffPayload) });
  } });
  tools.push({ name: 'get_followup_handoff', description: 'Show one pull request follow-up handoff: phase, status and the reason it is held, agent liveness, retained worktree and the next operator action.', scope: 'manage', permission, readOnly: true, schema: z.object(targetShape).strict(), run: async ({ args }) => {
    return ok({ status: await inspectOne(targetKey(args as { repository: string; pullRequest: number })) });
  } });
  tools.push({ name: 'release_followup_handoff', description: 'Stop tracking an operator-held follow-up handoff so new commands on its pull request can run. Frees the branch; never deletes retained files or commits. Refused while the agent still runs or the worktree holds unpublished work, unless force is true, which detaches the worktree HEAD anyway (the commits stay reachable in the worktree and under refs/propr/superseded).', scope: 'manage', permission, schema: z.object({ ...mutationShape, ...targetShape, force: z.boolean().default(false) }).strict(), run: async ({ args }) => {
    const key = targetKey(args as { repository: string; pullRequest: number });
    const result = await handoffs.releaseFollowupHandoffRecord(key, { force: args.force === true });
    if (result.released) return ok({ repository: key.repository, pullRequest: key.pull_request, released: true, forced: args.force === true });
    if (result.reason === 'not_found') throw new McpError('NOT_FOUND', 'No follow-up handoff is tracked for that pull request.', 404);
    throw new McpError('HANDOFF_NOT_RELEASED', `The handoff was not released: ${result.reason ?? 'unknown reason'}. Inspect it with get_followup_handoff; force releases a worktree that still holds unpublished work.`, 409, { stage: 'precondition', details: { reason: result.reason ?? null } });
  } });
  tools.push({ name: 'resume_followup_handoff', description: 'Re-arm an operator-held follow-up handoff and run a recovery pass for that pull request only, so its retained work is published or settled. Work the user cancelled is published only with authorizeCancelled true.', scope: 'manage', permission, schema: z.object({ ...mutationShape, ...targetShape, authorizeCancelled: z.boolean().default(false) }).strict(), run: async ({ args }) => {
    const key = targetKey(args as { repository: string; pullRequest: number });
    if (args.authorizeCancelled === true) {
      const record = await handoffs.authorizeCancelledFollowupHandoff(key);
      if (!record) throw new McpError('HANDOFF_NOT_RESUMED', 'Cancellation authorization was not granted: the handoff is missing, not operator-held, changed, or its pull request lease is held by another writer.', 409, { stage: 'precondition' });
    } else {
      const resumed = await handoffs.resumeOperatorHeldFollowupHandoff(key);
      if (!resumed.resumed) {
        if (resumed.reason === 'not_found') throw new McpError('NOT_FOUND', 'No follow-up handoff is tracked for that pull request.', 404);
        const hint = resumed.reason === 'requires_cancellation_authorization'
          ? 'The work was cancelled by the user; resume with authorizeCancelled true to publish it.'
          : `The handoff cannot be resumed: ${resumed.reason ?? 'unknown reason'}.`;
        throw new McpError('HANDOFF_NOT_RESUMED', hint, 409, { stage: 'precondition', details: { reason: resumed.reason ?? null } });
      }
    }
    const summary = await handoffs.recoverInterruptedFollowupHandoffs({}, key);
    const [status] = await handoffs.inspectFollowupHandoffs({}, key);
    return ok({ repository: key.repository, pullRequest: key.pull_request, summary, status: status ? handoffPayload(status) : null });
  } });
}
