import React from 'react';
import type { TaskType } from './types';

export const TaskTypeBadge: React.FC<{ type: TaskType }> = ({ type }) => {
  if (type === 'new-issue') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
        New Issue
      </span>
    );
  }

  if (type === 'followup') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 border border-purple-200">
        Followup
      </span>
    );
  }

  return null;
};
