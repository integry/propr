import type React from 'react';

/** What the overflow's Delete needs, wherever it is shown. */
export interface DeletionProps {
  isActive: boolean;
  stopFailed: boolean;
  deletingTask: boolean;
  onDeleteTask: () => void;
}

export interface OverflowMenuItem {
  label: string;
  title?: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

export const getDeleteState = (isActive: boolean, stopFailed: boolean, deletingTask: boolean) => {
  // Enable delete if task is not active, or if stop failed
  const canDelete = !isActive || stopFailed;
  const getTitle = () => {
    if (deletingTask) return 'Deleting...';
    if (stopFailed) return 'Delete task (stop failed, task may have already stopped)';
    if (isActive) return 'Stop the task before deleting';
    return 'Delete task';
  };
  return { isDisabled: !canDelete || deletingTask, title: getTitle() };
};
