import { API_BASE_URL, apiFetch } from './apiClient';

/**
 * Admin view of pull request follow-up handoffs: attempts whose publication is
 * still owed. A hold awaiting an operator blocks every later command on its
 * pull request, so the Maintenance section lists them and lets an
 * administrator resume or release them. Mirrors `/api/admin/followup-handoffs`.
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

const REASON_TEXT: Record<string, string> = {
  worktree_holds_unpublished_work: 'The retained worktree still holds unpublished work. Release with force to detach it anyway; the commits stay reachable.',
  agent_still_running: 'The attempt’s agent is still running.',
  liveness_unavailable: 'The attempt’s agent liveness could not be verified; stop the agent first.',
  lease_held_by_live_writer: 'Another job currently holds this pull request.',
  requires_cancellation_authorization: 'The user cancelled this work. Resume with cancellation authorization to publish it anyway.',
  not_resumable: 'The handoff is not in a state that can be resumed.',
};

async function failure(response: Response): Promise<Error> {
  if (response.status === 401 || response.status === 403) return new Error('Instance runtime administration is required.');
  let body: { error?: unknown; code?: unknown; reason?: unknown } = {};
  try { body = await response.json(); } catch { /* no body */ }
  if (response.status === 404) return new FollowupHandoffRefusedError('This follow-up handoff is no longer tracked.', 'not_found');
  const reason = typeof body.reason === 'string' ? body.reason : typeof body.code === 'string' ? body.code : null;
  if (response.status === 409) {
    const text = (reason && REASON_TEXT[reason]) || (typeof body.error === 'string' ? body.error : null) || `Refused (${reason ?? 'unknown reason'}).`;
    return new FollowupHandoffRefusedError(text, reason);
  }
  return new Error(typeof body.error === 'string' ? body.error : 'Follow-up handoff operation failed; the record is retained.');
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

export const releaseFollowupHandoff = (repository: string, pullRequest: number, options: { force?: boolean } = {}) =>
  request<{ released: true }>(`${target(repository, pullRequest)}/release`, { force: options.force === true });

export const resumeFollowupHandoff = (repository: string, pullRequest: number, options: { authorizeCancelled?: boolean } = {}) =>
  request<{ summary: FollowupHandoffRecoverySummary; status: FollowupHandoffStatus | null }>(`${target(repository, pullRequest)}/resume`, { authorizeCancelled: options.authorizeCancelled === true });
