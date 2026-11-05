import {
  FollowupHandoffDetail, FollowupHandoffList, FollowupHandoffReleaseRequest, FollowupHandoffReleaseResult,
  FollowupHandoffResumeRequest, FollowupHandoffResumeResult,
} from './schemas.js';
import type { RouteDoc } from './types.js';

const OPERATOR_RATE_LIMITED = {
  description: 'The operator recovery quota (`PROPR_OPERATOR_RATE_LIMIT_MAX` per `PROPR_OPERATOR_RATE_LIMIT_WINDOW_MS`, default 30 per minute) is exhausted; code `RATE_LIMIT_EXCEEDED`. Charged only after the admin guard passes, shared by every follow-up handoff route.',
};

const FOLLOWUP_HANDOFF_PATH_PARAMS = {
  owner: 'Repository owner (case-insensitive).',
  repo: 'Repository name (case-insensitive).',
  pr: 'Pull request number.',
};

/** Admin-only follow-up publication handoff recovery routes. */
export const ADMIN_ROUTE_DOCS: Record<string, RouteDoc> = {
  'GET /api/admin/followup-handoffs': {
    operationId: 'listFollowupHandoffs',
    summary: 'List durable follow-up publication handoffs awaiting recovery or an operator decision',
    description: 'Each record names its recovery phase, predecessor/successor task lineage, retained worktree path and the next action. Responses are `Cache-Control: no-store`.',
    tags: ['Administration'],
    responses: {
      200: { description: 'Every recorded handoff, including operator-held ones.', schema: FollowupHandoffList },
      429: OPERATOR_RATE_LIMITED,
    },
  },
  'GET /api/admin/followup-handoffs/:owner/:repo/:pr': {
    operationId: 'getFollowupHandoff',
    summary: 'Inspect one pull request\'s follow-up publication handoff',
    tags: ['Administration'],
    pathParams: FOLLOWUP_HANDOFF_PATH_PARAMS,
    responses: {
      200: { description: 'The handoff status.', schema: FollowupHandoffDetail },
      400: { description: 'The target is not a sane `owner/repo/pr` address.' },
      404: { description: 'No handoff is recorded for the pull request.' },
      429: OPERATOR_RATE_LIMITED,
    },
  },
  'POST /api/admin/followup-handoffs/:owner/:repo/:pr/resume': {
    operationId: 'resumeFollowupHandoff',
    summary: 'Re-arm an operator-held handoff and run a recovery pass keyed to this pull request',
    description: 'Without flags, an `awaiting_operator` record returns to `active` and one strictly keyed recovery pass runs: it resumes the exact missing publication phase idempotently and then releases the branch. Work the user cancelled is refused with code `requires_cancellation_authorization` until the request carries `authorizeCancelled: true` (for example after fixing a `worktree_missing` hold: restore the worktree, then resume). Publication side effects are limited to the addressed pull request.',
    tags: ['Administration'],
    pathParams: FOLLOWUP_HANDOFF_PATH_PARAMS,
    requestBody: { schema: FollowupHandoffResumeRequest, description: 'Optional flags; `{}` resumes a non-cancelled operator hold.' },
    responses: {
      200: { description: 'The keyed pass ran; `summary` counts its outcome and `status` is the state afterwards.', schema: FollowupHandoffResumeResult },
      400: { description: 'Invalid target or non-boolean flag.' },
      404: { description: 'No handoff is recorded for the pull request (code `not_found`).' },
      409: { description: 'The handoff cannot be resumed. `code` names why: `requires_cancellation_authorization`, `cancellation_authorization_unavailable` (also returned while another writer holds the PR lease), `lease_held_by_live_writer`, `released` or `superseded`.' },
      429: OPERATOR_RATE_LIMITED,
    },
  },
  'POST /api/admin/followup-handoffs/:owner/:repo/:pr/release': {
    operationId: 'releaseFollowupHandoff',
    summary: 'Release the handoff\'s branch from its retained worktree and retire the record',
    description: 'Detaches the retained worktree\'s HEAD (keeping every file) so the branch is usable again, then marks the record released. Refuses while the bound agent is live or unverifiable, while another writer holds the PR lease, or when unpublished work remains — pass `force: true` to release despite unpublished work. Releasing a `usage_limit_retry_unconfirmed` hold records that the usage-limit retry job exists and owns the request (settlement becomes `usage_limit_retry_scheduled`), so its comments are never suppressed as a cancellation; resume instead when no retry job exists. Worktree files are never deleted.',
    tags: ['Administration'],
    pathParams: FOLLOWUP_HANDOFF_PATH_PARAMS,
    requestBody: { schema: FollowupHandoffReleaseRequest, description: 'Optional flags; `{}` performs a safe release.' },
    responses: {
      200: { description: 'The branch is free and the record retired.', schema: FollowupHandoffReleaseResult },
      400: { description: 'Invalid target or non-boolean flag.' },
      404: { description: 'No handoff is recorded for the pull request (code `not_found`).' },
      409: { description: 'Refused; `reason` names why: `agent_still_running`, `liveness_unavailable`, `lease_held_by_live_writer`, `worktree_holds_unpublished_work`, `branch_still_registered`, `worktree_registrations_unavailable`, `cancelled_claims_withdrawal_failed` or `superseded` (the handoff changed concurrently, for example an operator re-armed it).', schema: FollowupHandoffReleaseResult },
      429: OPERATOR_RATE_LIMITED,
    },
  },
};
