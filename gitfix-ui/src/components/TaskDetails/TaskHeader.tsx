import React from 'react';
import { TaskInfo } from './types';
import { getStatusIcon } from './utils';

interface TaskHeaderProps {
  taskInfo: TaskInfo | null;
  currentStatus: string;
}

const getSubtitle = (taskInfo: TaskInfo): string => {
  if (taskInfo.subtitle) return taskInfo.subtitle;
  if (taskInfo.type === 'pr-comment') {
    return `Follow-up changes for PR #${taskInfo.number}`;
  }
  return `Initial implementation for Issue #${taskInfo.number}`;
};

const TaskHeader: React.FC<TaskHeaderProps> = ({ taskInfo, currentStatus }) => (
  <>
    <div className="flex items-center gap-3 mb-2">
      <span className="text-2xl">{getStatusIcon(currentStatus)}</span>
      <h2 className="text-2xl font-bold text-gray-900 break-all">
        {taskInfo?.title || 'Loading...'}
      </h2>
    </div>
    {taskInfo && (
      <p className="text-gray-600 mb-6 ml-10">{getSubtitle(taskInfo)}</p>
    )}
  </>
);

export default TaskHeader;
