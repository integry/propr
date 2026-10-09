import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttributedUser } from '@propr/shared';
import {
  getAssignableUsers,
  getTaskAssignees,
  isNoAssignmentSubjectError,
  setTaskAssignees,
  TaskAssigneesRejectedError,
  TaskAssignmentRequestError,
  type TaskAssignmentSubject,
} from '../../api/taskAssignment';
import { isDemoModeReadOnlyError } from '../../api/apiClient';
import { useToast } from '../ui/useToast';

const errorMessage = (error: unknown): string => (error as Error | null)?.message || 'Unknown error';

/** A save the viewer may not make: no write access to the repository, or a read-only demo. */
const isReadOnlyError = (error: unknown): boolean =>
  isDemoModeReadOnlyError(error) || (error instanceof TaskAssignmentRequestError && error.status === 403);

export interface AssignableUsersState {
  users: AttributedUser[] | null;
  /** True when the repository has more assignable users than were listed. */
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

export interface TaskAssignment {
  taskId: string | undefined;
  /** The current assignees; optimistic while a save is in flight. */
  assignees: AttributedUser[];
  subject: TaskAssignmentSubject | null;
  /** The first read has not answered yet. */
  loading: boolean;
  /** The first read failed for a reason other than there being nothing to assign. */
  error: string | null;
  /** The task has no issue or pull request (a goal task), so it has no assignment at all. */
  unavailable: boolean;
  /** False once a save was refused for lack of write access; the editor is not offered again. */
  editable: boolean;
  saving: boolean;
  /** Replaces the assignees with `logins` (an empty list unassigns); resolves whether it succeeded. */
  save: (logins: string[]) => Promise<boolean>;
  assignable: AssignableUsersState;
  /** Reads the assignable users the first time it is called; later calls reuse them. */
  loadAssignableUsers: () => void;
}

const INITIAL_ASSIGNABLE: AssignableUsersState = { users: null, truncated: false, loading: false, error: null };

/**
 * The task's assignment on its issue or pull request: read on mount, written
 * through GitHub with an optimistic update that rolls back and toasts on
 * failure, as the page reports a failed stop or delete.
 */
export function useTaskAssignment(taskId: string | undefined): TaskAssignment {
  const { addToast } = useToast();
  const [assignees, setAssignees] = useState<AttributedUser[]>([]);
  const [subject, setSubject] = useState<TaskAssignmentSubject | null>(null);
  const [loading, setLoading] = useState(Boolean(taskId));
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [editable, setEditable] = useState(true);
  const [saving, setSaving] = useState(false);
  const [assignable, setAssignable] = useState<AssignableUsersState>(INITIAL_ASSIGNABLE);
  // Answers for a task that is no longer on screen are dropped.
  const currentTaskId = useRef(taskId);
  currentTaskId.current = taskId;
  const assigneesRef = useRef(assignees);
  assigneesRef.current = assignees;
  const assignableRequested = useRef(false);
  const saveGeneration = useRef(0);

  useEffect(() => {
    setAssignees([]);
    setSubject(null);
    setError(null);
    setUnavailable(false);
    setEditable(true);
    setSaving(false);
    setAssignable(INITIAL_ASSIGNABLE);
    assignableRequested.current = false;
    saveGeneration.current += 1;
    if (!taskId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    getTaskAssignees(taskId)
      .then(response => {
        if (cancelled) return;
        // A malformed answer is a failed read; it hides the control rather than breaking the page.
        if (!Array.isArray(response?.assignees)) {
          setError('Unexpected assignees response');
          return;
        }
        setAssignees(response.assignees);
        setSubject(response.subject ?? null);
      })
      .catch(err => {
        if (cancelled) return;
        if (isNoAssignmentSubjectError(err)) setUnavailable(true);
        else setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [taskId]);

  const loadAssignableUsers = useCallback(() => {
    if (!taskId || assignableRequested.current) return;
    assignableRequested.current = true;
    setAssignable(state => ({ ...state, loading: true, error: null }));
    getAssignableUsers(taskId)
      .then(response => {
        if (currentTaskId.current !== taskId) return;
        setAssignable({ users: response.users, truncated: response.truncated, loading: false, error: null });
      })
      .catch(err => {
        if (currentTaskId.current !== taskId) return;
        // A failed read may be retried by opening the editor again.
        assignableRequested.current = false;
        setAssignable(state => ({ ...state, loading: false, error: errorMessage(err) }));
      });
  }, [taskId]);

  const save = useCallback(async (logins: string[]): Promise<boolean> => {
    if (!taskId) return false;
    const previous = assigneesRef.current;
    const known = new Map([...(assignable.users ?? []), ...previous].map(user => [user.login.toLowerCase(), user]));
    const generation = ++saveGeneration.current;
    const isCurrent = () => currentTaskId.current === taskId && saveGeneration.current === generation;
    setAssignees(logins.map(login => known.get(login.toLowerCase())
      ?? { id: `login:${login}`, login, displayName: null, avatarUrl: null }));
    setSaving(true);
    try {
      const response = await setTaskAssignees(taskId, logins, 'replace');
      if (!isCurrent()) return true;
      if (Array.isArray(response?.assignees)) setAssignees(response.assignees);
      if (response?.subject) setSubject(response.subject);
      return true;
    } catch (err) {
      if (!isCurrent()) return false;
      if (err instanceof TaskAssigneesRejectedError) {
        // GitHub applied part of the change; show what it confirmed.
        setAssignees(err.assignees);
        addToast({ type: 'error', message: err.message });
        return false;
      }
      setAssignees(previous);
      if (isReadOnlyError(err)) {
        setEditable(false);
        addToast({ type: 'error', message: `You can't change who is assigned to this task: ${errorMessage(err)}` });
      } else {
        console.error('Error updating task assignees:', err);
        addToast({ type: 'error', message: `Failed to update assignees: ${errorMessage(err)}` });
      }
      return false;
    } finally {
      if (isCurrent()) setSaving(false);
    }
  }, [taskId, assignable.users, addToast]);

  return {
    taskId,
    assignees,
    subject,
    loading,
    error,
    unavailable,
    editable,
    saving,
    save,
    assignable,
    loadAssignableUsers,
  };
}
