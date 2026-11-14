import type { PlanExecutionQueueBlockedKind } from '../../api/planIssuesApi';

/** How each reason kind that holds an issue of the execution queue reads in Planner Studio. */
export const BLOCKED_KIND_LABELS: Record<PlanExecutionQueueBlockedKind, string> = {
  closed_unmerged: 'Closed without merge',
  missing_from_plan: 'Missing from plan',
  dispatch_failed: 'Could not start',
  agent_blocked: 'Agent reported a blocker',
  awaiting_human_merge: 'Waiting for a human merge',
  label_handoff: 'Labels not released',
  setup_not_ready: 'Setup not finished',
};
