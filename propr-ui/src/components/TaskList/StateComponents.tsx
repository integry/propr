import React from 'react';
import { LoaderCircle } from 'lucide-react';
import type { TaskGroup } from './types';
import { ParentTaskRow, ChildTaskRow, CollapseToggleRow } from './TaskRows';
import { MobileTaskCard } from './MobileTaskCard';
import { SystemAlert } from '../ui/SystemAlert';
import { useDesktop } from '../../desktop/DesktopContext';
import './desktop-task-table.css';

/** Renders a simple loading message for dashboard integration */
export const DashboardLoadingState: React.FC = () => (
  <div role="status" className="flex items-center gap-2 p-4 text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Loading tasks...</div>
);

/** Renders a full-page loading state with header for the main Tasks page */
export const FullPageLoadingState: React.FC = () => (
  <div className="flex flex-col h-full">
    <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-6 py-4">
      <h1 className="text-2xl font-bold text-gray-800">Tasks</h1>
    </div>
    <div className="flex-1 overflow-auto px-6 py-6">
      <div role="status" className="flex items-center gap-2 text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Loading tasks...</div>
    </div>
  </div>
);

/** Renders a simple error message for dashboard integration */
export const DashboardErrorState: React.FC<{ error: string }> = ({ error }) => (
  <SystemAlert>Error loading tasks: {error}</SystemAlert>
);

/** Renders a full-page error state with header for the main Tasks page */
export const FullPageErrorState: React.FC<{ error: string }> = ({ error }) => (
  <div className="flex flex-col h-full">
    <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-6 py-4">
      <h1 className="text-2xl font-bold text-gray-800">Tasks</h1>
    </div>
    <div className="flex-1 overflow-auto px-6 py-6">
      <SystemAlert>Error loading tasks: {error}</SystemAlert>
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
}) => {
  const desktop = useDesktop();
  const desktopLayout = desktop?.platform === 'macos' || desktop?.platform === 'linux';

  return (
    <>
      {/* Mobile Card View */}
      <div className="md:hidden">
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
      <div className={desktopLayout ? 'desktop-task-list hidden md:block' : 'hidden md:block'}>
        <table className="w-full">
          {desktopLayout && (
            <colgroup>
              <col className="task-repository" />
              <col />
              <col className="task-status" />
              <col className="task-metadata" />
            </colgroup>
          )}
          <thead className="sr-only">
            <tr>
              <th className="task-repository">Repository</th>
              <th>Issue/Task</th>
              <th>Status</th>
              <th>Metadata</th>
              {!desktopLayout && <th>Actions</th>}
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
                  <ParentTaskRow desktopLayout={desktopLayout} group={group} task={parentTask} onRowClick={onRowClick} isDuplicateRepo={isDuplicateRepo} />

                  {visibleChildren.map((child, childIndex) => (
                    <ChildTaskRow
                      desktopLayout={desktopLayout}
                      key={child.id}
                      task={child}
                      onRowClick={onRowClick}
                      isLastChild={childIndex === visibleChildren.length - 1 && hiddenCount === 0}
                    />
                  ))}

                  {hiddenCount > 0 && (
                    <CollapseToggleRow desktopLayout={desktopLayout} groupKey={group.key} hiddenCount={hiddenCount} onToggle={onToggleGroup} />
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};
