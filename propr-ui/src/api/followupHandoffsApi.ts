import { API_BASE_URL, apiFetch } from './apiClient';

/**
 * Admin view of held follow-ups: follow-up attempts that stopped before their
 * work reached the pull request (the API calls them follow-up handoffs). One
 * held for a decision blocks new commands on its pull request, so Settings →
 * Maintenance lists them and lets an administrator resume or release them.
 * Mirrors `/api/admin/followup-handoffs`.
 */
export interface FollowupHandoffStatus {
  repository: string;
  pullRequest: number;
  taskId: string;
  predecessorTaskIds: string[];
  successorTaskId: string | null;
  phase: string;
  status: string;
  statusReason: string | null;
  settlement: string | null;
  operatorAuthorized: boolean;
  liveness: string;
  branchName: string;
  commitHash: string | null;
  completionCommentUrl: string | null;
  nextAction: string;
  retainedWorktreePath: string;
  updatedAt: number;
}

export interface FollowupHandoffRecoverySummary {
  inspected: number; published: number; noChanges: number; settled: number; cleanupPending: number;
  skippedLiveAgent: number; failedClosed: number; awaitingOperator: number; lockedByOtherWriter: number; errors: number;
}

/** The server declined the operation and said why; the record is unchanged. */
export class FollowupHandoffRefusedError extends Error {
  constructor(message: string, readonly reason: string | null) {
    super(message);
    this.name = 'FollowupHandoffRefusedError';
  }
}

const base = () => `${API_BASE_URL}/api/admin/followup-handoffs`;
const target = (repository: string, pullRequest: number) => {
  const [owner, repo] = repository.split('/');
  return `${base()}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(String(pullRequest))}`;
};

const REFUSED = 'This follow-up can’t be changed right now. Try again shortly.';
const NO_LONGER_HELD = 'This follow-up is no longer held.';
const UNPUBLISHED = 'This follow-up still has unpublished work. Tick the box to release it anyway; the commits are kept.';

/** Why the server refused, in the words the Maintenance screen uses. */
const REASON_TEXT: Record<string, string> = {
  worktree_holds_unpublished_work: UNPUBLISHED,
  unpublished_commits_still_on_branch: UNPUBLISHED,
  agent_still_running: 'Its agent is still running. Try again when it finishes.',
  liveness_unavailable: 'Its agent can’t be checked right now. Try again shortly.',
  lease_held_by_live_writer: 'Another job is working on this pull request. Try again shortly.',
  branch_still_registered: 'Another worktree still uses this branch. Try again shortly.',
  worktree_registrations_unavailable: 'The worktrees can’t be checked right now. Try again shortly.',
  cancelled_claims_withdrawal_failed: 'The cancelled comments couldn’t be withdrawn. Try again shortly.',
  requires_cancellation_authorization: 'This work was cancelled. Tick “Publish the cancelled work” to resume it.',
  cancellation_authorization_unavailable: 'This follow-up can’t be resumed.',
  not_resumable: 'This follow-up can’t be resumed.',
  followup_handoff_ownership_lost: 'This follow-up can’t be resumed.',
  released: NO_LONGER_HELD,
  superseded: 'This follow-up changed in the meantime. Check the list and try again.',
};

async function failure(response: Response): Promise<Error> {
  if (response.status === 401 || response.status === 403) return new Error('Only instance administrators can do this.');
  if (response.status === 429) return new Error('Too many requests. Try again in a minute.');
  let body: { error?: unknown; code?: unknown; reason?: unknown } = {};
  try { body = await response.json(); } catch { /* no body */ }
  if (response.status === 404) return new FollowupHandoffRefusedError(NO_LONGER_HELD, 'not_found');
  const reason = typeof body.reason === 'string' ? body.reason : typeof body.code === 'string' ? body.code : null;
  // The server's own wording is written for the CLI and the API, so it is never shown here.
  if (response.status === 409) return new FollowupHandoffRefusedError((reason && REASON_TEXT[reason]) || REFUSED, reason);
  return new Error('Something went wrong. The follow-up is unchanged.');
}

async function request<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await apiFetch(url, {
    credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await failure(response);
  return response.json() as Promise<T>;
}

export const listFollowupHandoffs = async (): Promise<FollowupHandoffStatus[]> =>
  (await request<{ handoffs: FollowupHandoffStatus[] }>(base())).handoffs;

/**
 * `taskId` names the attempt the administrator confirmed. The server releases
 * (and forces) only while that attempt is still the current one on the pull
 * request, and refuses with `superseded` otherwise.
 */
export const releaseFollowupHandoff = (repository: string, pullRequest: number, options: { force?: boolean; taskId?: string } = {}) =>
  request<{ released: true }>(`${target(repository, pullRequest)}/release`, {
    force: options.force === true,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
  });

/**
 * `taskId` names the attempt the administrator decided about. The server
 * authorizes cancelled work only while that attempt is still the current one on
 * the pull request, and refuses with `superseded` otherwise.
 */
export const resumeFollowupHandoff = (repository: string, pullRequest: number, options: { authorizeCancelled?: boolean; taskId?: string } = {}) =>
  request<{ summary: FollowupHandoffRecoverySummary; status: FollowupHandoffStatus | null }>(`${target(repository, pullRequest)}/resume`, {
    authorizeCancelled: options.authorizeCancelled === true,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
  });
