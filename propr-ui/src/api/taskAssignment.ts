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

/**
 * An assignment request the server answered with an error status, carrying the
 * status and the body's `code` so callers can tell a task without an issue or
 * pull request (409) or a viewer without write access (403) from an outage.
 */
export class TaskAssignmentRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | undefined) {
    super(message);
    this.name = 'TaskAssignmentRequestError';
  }
}

/** The codes a 409 carries when a task has no issue or pull request to assign, as a goal task does. */
export const NO_ASSIGNMENT_SUBJECT_CODES: readonly string[] = ['NO_GITHUB_SUBJECT', 'NO_ASSIGNMENT_SUBJECT'];

export const isNoAssignmentSubjectError = (error: unknown): boolean =>
  error instanceof TaskAssignmentRequestError && error.status === 409
  && (error.code === undefined || NO_ASSIGNMENT_SUBJECT_CODES.includes(error.code));

/** Re-throws `handleApiResponse`'s plain errors with the response's status and code. */
const handleAssignmentResponse = async (response: Response): Promise<void> => {
  try {
    await handleApiResponse(response);
  } catch (error) {
    // Demo-mode, session and other typed errors keep their own class.
    if (!(error instanceof Error) || error.constructor !== Error) throw error;
    const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
    throw new TaskAssignmentRequestError(error.message, response.status, typeof body?.code === 'string' ? body.code : undefined);
  }
};

const taskAssignmentUrl = (taskId: string, path: string): string =>
  `${API_BASE_URL}/api/task/${encodeURIComponent(taskId)}/${path}`;

export const getTaskAssignees = async (taskId: string): Promise<TaskAssigneesResponse> => {
  const response = await apiFetch(taskAssignmentUrl(taskId, 'assignees'), { credentials: 'include' });
  await handleAssignmentResponse(response);
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
    await handleAssignmentResponse(response);
  } catch (error) {
    if (!(error instanceof TaskAssignmentRequestError) || error.status !== 422) throw error;
    const body = await response.clone().json().catch(() => null) as Partial<SetTaskAssigneesResponse> | null;
    // Only a partial result has a confirmed set; an outright GitHub rejection stays an ordinary error.
    if (error.code !== 'GITHUB_REJECTED' || !body?.subject || !Array.isArray(body.assignees) || !Array.isArray(body.rejected)) throw error;
    throw new TaskAssigneesRejectedError(error.message, body.subject, body.assignees, body.rejected);
  }
  return response.json();
};

export const getAssignableUsers = async (taskId: string): Promise<AssignableUsersResponse> => {
  const response = await apiFetch(taskAssignmentUrl(taskId, 'assignable-users'), { credentials: 'include' });
  await handleAssignmentResponse(response);
  return response.json();
};
