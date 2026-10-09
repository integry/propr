/**
 * Task assignment API
 *
 * Client wrapper for the task detail page's assignment endpoints. Reading
 * serves GitHub's live assignment, writing goes through GitHub (it stays the
 * authority), and the assignable users are the repository's candidates.
 */
import type { AttributedUser } from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export type { AttributedUser };

/** The GitHub issue or pull request a task's assignment lives on. */
export interface TaskAssignmentSubject {
  owner: string;
  repo: string;
  number: number;
  kind: 'issue' | 'pull_request';
}

export interface TaskAssigneesResponse {
  subject: TaskAssignmentSubject;
  assignees: AttributedUser[];
  /** True when `assignees` was just read from GitHub; false when it is the stored set. */
  synced: boolean;
}

export interface SetTaskAssigneesResponse {
  subject: TaskAssignmentSubject;
  /** The assignees GitHub confirmed. */
  assignees: AttributedUser[];
  /** Requested users GitHub did not assign; empty on success. */
  rejected: AttributedUser[];
}

/** `replace` makes `logins` the whole set (an empty list clears it); `add` keeps current assignees. */
export type TaskAssignmentMode = 'add' | 'replace';

export interface AssignableUsersResponse {
  users: AttributedUser[];
  /** True when the repository has more assignable users than were listed. */
  truncated: boolean;
}

/**
 * GitHub applied part of a `setTaskAssignees` update and rejected the rest. The
 * assignment did change, so the error carries the confirmed set alongside the
 * rejected users for the caller to reconcile with.
 */
export class TaskAssigneesRejectedError extends Error {
  readonly status = 422;
  readonly code = 'GITHUB_REJECTED';

  constructor(
    message: string,
    readonly subject: TaskAssignmentSubject,
    /** The assignees GitHub confirmed after applying what it accepted. */
    readonly assignees: AttributedUser[],
    /** Requested users GitHub did not assign. */
    readonly rejected: AttributedUser[],
  ) {
    super(message);
    this.name = 'TaskAssigneesRejectedError';
  }
}

const taskAssignmentUrl = (taskId: string, path: string): string =>
  `${API_BASE_URL}/api/task/${encodeURIComponent(taskId)}/${path}`;

export const getTaskAssignees = async (taskId: string): Promise<TaskAssigneesResponse> => {
  const response = await apiFetch(taskAssignmentUrl(taskId, 'assignees'), { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const setTaskAssignees = async (
  taskId: string,
  logins: string[],
  mode: TaskAssignmentMode = 'replace',
): Promise<SetTaskAssigneesResponse> => {
  const response = await apiFetch(taskAssignmentUrl(taskId, 'assignees'), {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logins, mode }),
  });
  try {
    await handleApiResponse(response);
  } catch (error) {
    // Demo-mode, session and other typed errors keep their own class.
    if (response.status !== 422 || !(error instanceof Error) || error.constructor !== Error) throw error;
    const body = await response.clone().json().catch(() => null) as Partial<SetTaskAssigneesResponse> & { code?: unknown } | null;
    // Only a partial result has a confirmed set; an outright GitHub rejection stays an ordinary error.
    if (body?.code !== 'GITHUB_REJECTED' || !body.subject || !Array.isArray(body.assignees) || !Array.isArray(body.rejected)) throw error;
    throw new TaskAssigneesRejectedError(error.message, body.subject, body.assignees, body.rejected);
  }
  return response.json();
};

export const getAssignableUsers = async (taskId: string): Promise<AssignableUsersResponse> => {
  const response = await apiFetch(taskAssignmentUrl(taskId, 'assignable-users'), { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};
