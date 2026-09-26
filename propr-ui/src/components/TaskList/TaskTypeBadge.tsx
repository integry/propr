import React from 'react';
import type { TaskType } from './types';

interface TaskTypeBadgeProps {
  type: TaskType;
  /** Workflow verb for PR-scoped tasks, e.g. "Fix" or "Review". */
  label?: string;
}

export const TaskTypeBadge: React.FC<TaskTypeBadgeProps> = ({ type, label }) => {
  if (type === 'new-issue') {
    return (
      <span className="inline-flex items-center font-mono px-2 py-0.5 rounded-sm text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">
        New Issue
      </span>
    );
  }

  if (type === 'followup') {
    return (
      <span className="inline-flex items-center font-mono px-2 py-0.5 rounded-sm text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">
        Followup
      </span>
    );
  }

  if (type === 'pr-workflow' && label) {
    return (
      <span className="inline-flex items-center font-mono px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700 border border-gray-300">
        {label}
      </span>
    );
  }

  return null;
};
