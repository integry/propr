import React from 'react';
import type { TaskType } from './types';

export const TaskTypeBadge: React.FC<{ type: TaskType }> = ({ type }) => {
  if (type === 'new-issue') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 border border-green-200">
        New Issue
      </span>
    );
  }

  if (type === 'followup') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700 border border-gray-300">
        Followup
      </span>
    );
  }

  return null;
};
