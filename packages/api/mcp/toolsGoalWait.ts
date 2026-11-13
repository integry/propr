import { z } from 'zod';
import { GOAL_WAIT_CONDITIONS, GOAL_WAIT_DEFAULT_TIMEOUT_SECONDS, GOAL_WAIT_MAX_TIMEOUT_SECONDS } from '@propr/shared';
import { GoalWaitError, waitForGoal } from '../services/goalWait.js';
import { McpError } from './config.js';
import type { McpPolicy, McpPrincipal } from './policy.js';
import type { McpGrant } from './oauth.js';
import { type McpTool, type ToolDeps, repositorySchema, ok } from './tools.js';

/**
 * A grant revoked while a wait is open must stop receiving goal events, so the
 * stored grant is re-read before every journal read. Connect delegations are
 * validated per request and are not stored on this instance.
 */
export async function assertGrantActive(policy: McpPolicy, principal: McpPrincipal): Promise<void> {
  if (principal.grant.membershipSource === 'connect') return;
  const grant = await policy.oauth.store.get<McpGrant>('grant', principal.grant.id);
  if (!grant || grant.revoked || grant.expiresAt <= Date.now() || grant.ownerId !== principal.user.id) {
    throw new McpError('ACCESS_REVOKED', 'This grant was revoked or expired while waiting.', 403);
  }
}

export function addGoalWaitTools(tools: McpTool[], deps: ToolDeps, goalTarget: NonNullable<McpTool['target']>): void {
  tools.push({
    name: 'wait_goal',
    description: `Wait, bounded, for a goal state or a new durable goal event instead of polling get_goal. until: completed, failed, cancelled, paused (confirmed states only; a pause or cancel request does not match), terminal (any of completed/failed/cancelled), checkpoint (a checkpoint published after the cursor) or blocked (the goal's agent opened a question or approval for its operator; event.blocker names it, and get_goal or list_goal_attention shows the question). Omit until to wait for any new event, including a blocker opening or closing. Without afterCursor a state condition that already holds matches immediately, and blocked matches a still-open blocker of the current attempt; otherwise only events after the current boundary count. With afterCursor only newer events count, so pass the returned cursor to resume without missing or repeating a transition. timeoutSeconds defaults to ${GOAL_WAIT_DEFAULT_TIMEOUT_SECONDS} (max ${GOAL_WAIT_MAX_TIMEOUT_SECONDS}). outcome is matched, timed_out (not a goal failure; retry with the returned cursor) or unreachable (reserved for conditions that cannot ever match). Terminal goals can be continued; waits after a terminal cursor remain open for later events. A finished child task or idle agent output never counts as goal completion. Cancelling the wait never affects the goal.`,
    scope: 'read',
    readOnly: true,
    schema: z.object({
      repository: repositorySchema,
      goalId: z.uuid(),
      afterCursor: z.string().min(1).max(512).optional().describe('Opaque cursor returned by an earlier wait_goal on this goal.'),
      until: z.enum(GOAL_WAIT_CONDITIONS).optional(),
      timeoutSeconds: z.number().min(0).max(GOAL_WAIT_MAX_TIMEOUT_SECONDS).default(GOAL_WAIT_DEFAULT_TIMEOUT_SECONDS),
    }).strict(),
    target: goalTarget,
    run: async ({ principal, args, signal }) => {
      try {
        return ok(await waitForGoal({
          db: deps.db, ownerId: principal.user.id, goalId: args.goalId, repository: args.repository,
          afterCursor: args.afterCursor, until: args.until, timeoutSeconds: args.timeoutSeconds, signal,
          authorize: () => assertGrantActive(deps.policy, principal),
        }));
      } catch (error) {
        if (error instanceof GoalWaitError) {
          throw new McpError(error.code, error.message, error.status, error.recovery ? { details: { recovery: error.recovery } } : {});
        }
        throw error;
      }
    },
  });
}
