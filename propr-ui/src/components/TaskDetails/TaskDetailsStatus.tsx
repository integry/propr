import React from 'react';
import { NotFound } from '../NotFound';
import { isNotFoundMessage } from '../../utils/notFound';

/** The task page before (or instead of) the task: loading, not found, or a failed read. */

const centeredStatus = (className: string, children: React.ReactNode) => (
  <div className="h-full bg-white flex items-center justify-center">
    <div className={className}>{children}</div>
  </div>
);

/**
 * Whether the task's read came back without a task: no history for the id, or
 * an id the API refused or does not know (an invalid id is not found, too).
 */
export const isTaskNotFound = (
  loading: boolean,
  error: string | null | undefined,
  history: readonly unknown[] | null | undefined,
) => !loading && (error ? isNotFoundMessage(error) : !history || history.length === 0);

export const renderTaskDetailsStatus = (
  loading: boolean,
  error: string | null | undefined,
  notFound: boolean,
) => {
  if (loading) return centeredStatus('text-gray-600', 'Loading task details...');

  if (notFound) {
    return (
      <div className="h-full bg-white">
        <NotFound
          title="Task not found"
          message="This task does not exist, or it has been deleted."
          backTo="/tasks"
          backLabel="Back to tasks"
          setsDocumentTitle={false}
        />
      </div>
    );
  }

  if (error) return centeredStatus('text-red-600', `Error loading task details: ${error}`);

  return null;
};
