import React from 'react';
import type { TaskGroup } from './types';
import { ParentTaskRow, ChildTaskRow, CollapseToggleRow } from './TaskRows';
import { MobileTaskCard } from './MobileTaskCard';

/** Renders a simple loading message for dashboard integration */
export const DashboardLoadingState: React.FC = () => (
  <div className="text-gray-500 p-4">Loading tasks...</div>
);

/** Renders a full-page loading state with header for the main Tasks page */
export const FullPageLoadingState: React.FC = () => (
  <div className="flex flex-col h-full">
    <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-6 py-4">
      <h1 className="text-2xl font-bold text-gray-800">Tasks</h1>
    </div>
    <div className="flex-1 overflow-auto px-6 py-6">
      <div className="text-gray-500">Loading tasks...</div>
    </div>
  </div>
);

/** Renders a simple error message for dashboard integration */
export const DashboardErrorState: React.FC<{ error: string }> = ({ error }) => (
  <div className="text-red-600 p-4">Error loading tasks: {error}</div>
);

/** Renders a full-page error state with header for the main Tasks page */
export const FullPageErrorState: React.FC<{ error: string }> = ({ error }) => (
  <div className="flex flex-col h-full">
    <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-6 py-4">
      <h1 className="text-2xl font-bold text-gray-800">Tasks</h1>
    </div>
    <div className="flex-1 overflow-auto px-6 py-6">
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">Error loading tasks: {error}</div>
    </div>
  </div>
);

interface TaskTableContentProps {
  groupedTasks: TaskGroup[];
  expandedGroups: Set<string>;
  onRowClick: (taskId: string) => void;
  onToggleGroup: (groupKey: string, e: React.MouseEvent) => void;
}

/** Renders the desktop table and mobile card views for tasks */
export const TaskTableContent: React.FC<TaskTableContentProps> = ({
  groupedTasks,
  expandedGroups,
  onRowClick,
  onToggleGroup,
}) => (
  <>
    {/* Mobile Card View */}
    <div className="md:hidden space-y-3 px-4 py-4">
      {groupedTasks.map((group) => (
        <MobileTaskCard
          key={group.key}
          group={group}
          expandedGroups={expandedGroups}
          onRowClick={onRowClick}
          onToggleGroup={onToggleGroup}
        />
      ))}
    </div>

    {/* Desktop Table View */}
    <div className="hidden md:block">
      <table className="w-full">
        <thead className="sr-only">
          <tr>
            <th>Repository</th>
            <th>Issue/Task</th>
            <th>Status</th>
            <th>Metadata</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody className="bg-white">
          {groupedTasks.map((group, index) => {
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

            const prevGroup = index > 0 ? groupedTasks[index - 1] : null;
            const isDuplicateRepo = prevGroup
              ? prevGroup.repoOwner === group.repoOwner && prevGroup.repoName === group.repoName
              : false;

            return (
              <React.Fragment key={group.key}>
                <ParentTaskRow group={group} task={parentTask} onRowClick={onRowClick} isDuplicateRepo={isDuplicateRepo} />

                {visibleChildren.map((child, childIndex) => (
                  <ChildTaskRow
                    key={child.id}
                    task={child}
                    onRowClick={onRowClick}
                    isLastChild={childIndex === visibleChildren.length - 1 && hiddenCount === 0}
                  />
                ))}

                {hiddenCount > 0 && (
                  <CollapseToggleRow groupKey={group.key} hiddenCount={hiddenCount} onToggle={onToggleGroup} />
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  </>
);
