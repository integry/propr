import React from 'react';
import { ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
import type { Task, TaskGroup } from './types';
import { getTaskTypeInfo, getStatusPill, formatRelativeTime, formatDuration } from './utils';
import { TaskTypeBadge } from './TaskTypeBadge';
import { ScoreBadge } from './ScoreBadge';

// Helper function to check if a task should be dimmed (merged or closed)
const shouldDimTask = (task: Task): boolean => {
  const status = task.planIssueStatus?.toLowerCase();
  return status === 'merged' || status === 'closed';
};

interface MobileTaskCardProps {
  group: TaskGroup;
  expandedGroups: Set<string>;
  onRowClick: (taskId: string) => void;
  onToggleGroup: (groupKey: string, e: React.MouseEvent) => void;
}

const MobileTaskItemWithGroup: React.FC<{
  task: Task;
  group: TaskGroup;
  isChild?: boolean;
  onRowClick: (taskId: string) => void;
}> = ({ task, group, isChild = false, onRowClick }) => {
  const typeInfo = getTaskTypeInfo(task);
  const isDimmed = shouldDimTask(task);
  const displayTitle = (() => {
    if (typeInfo.type === 'followup' && task.subtitle) {
      return task.subtitle;
    }
    return typeInfo.cleanTitle || task.subtitle || 'No title';
  })();

  return (
    <div
      onClick={() => onRowClick(task.id)}
      className={`flex items-start justify-between gap-2 py-3 cursor-pointer active:bg-gray-50 ${
        isChild ? 'pl-4 border-l-2 border-gray-200 ml-2' : ''
      } ${isDimmed ? 'opacity-40' : ''}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          {!isChild && (
            <>
              {group.prNumber ? (
                <span className="text-sm font-bold text-primary-600">
                  PR #{group.prNumber}
                </span>
              ) : task.issueNumber ? (
                <span className="text-sm font-bold text-primary-600">
                  #{task.issueNumber}
                </span>
              ) : null}
              <TaskTypeBadge type={typeInfo.type} />
            </>
          )}
          {getStatusPill(task.status)}
          <ScoreBadge score={task.critiqueScore} />
        </div>
        <p className={`text-sm text-gray-900 line-clamp-2 ${isChild ? 'text-gray-600' : 'font-medium'}`}>
          {displayTitle}
        </p>
        <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
          <span>{formatRelativeTime(task.createdAt)}</span>
          <span className="text-gray-300">•</span>
          <span className="font-mono">{formatDuration(task.processedAt || task.createdAt, task.completedAt)}</span>
        </div>
      </div>
      <ChevronRight size={16} className="text-gray-400 flex-shrink-0 mt-1" />
    </div>
  );
};

export const MobileTaskCard: React.FC<MobileTaskCardProps> = ({
  group,
  expandedGroups,
  onRowClick,
  onToggleGroup,
}) => {
  const parentTask = group.tasks[0];
  const allChildren = group.tasks.slice(1);
  const isExpanded = expandedGroups.has(group.key);

  const shouldCollapse = allChildren.length > 3;
  let visibleChildren = allChildren;
  let hiddenCount = 0;

  if (shouldCollapse && !isExpanded) {
    visibleChildren = allChildren.slice(0, 3);
    hiddenCount = allChildren.length - 3;
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Card Header with Repository */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-100">
        <span className="text-xs font-medium text-gray-600">
          {group.repoOwner}/{group.repoName}
        </span>
        <span className="text-xs text-gray-400">
          {new Date(parentTask.createdAt).toLocaleDateString()}
        </span>
      </div>

      {/* Main Task */}
      <div className="px-4">
        <MobileTaskItemWithGroup
          task={parentTask}
          group={group}
          onRowClick={onRowClick}
        />

        {/* Child Tasks */}
        {visibleChildren.length > 0 && (
          <div className="border-t border-gray-100">
            {visibleChildren.map((child) => (
              <MobileTaskItemWithGroup
                key={child.id}
                task={child}
                group={group}
                isChild
                onRowClick={onRowClick}
              />
            ))}
          </div>
        )}

        {/* Show More / Collapse Toggle */}
        {hiddenCount > 0 && (
          <button
            onClick={(e) => onToggleGroup(group.key, e)}
            className="w-full py-2 text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center justify-center gap-1 border-t border-gray-100"
          >
            <ChevronDown size={14} />
            Show {hiddenCount} more
          </button>
        )}

        {shouldCollapse && isExpanded && (
          <button
            onClick={(e) => onToggleGroup(group.key, e)}
            className="w-full py-2 text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center justify-center gap-1 border-t border-gray-100"
          >
            <ChevronUp size={14} />
            Show less
          </button>
        )}
      </div>
    </div>
  );
};
