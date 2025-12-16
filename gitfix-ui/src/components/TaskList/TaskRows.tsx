import React from 'react';
import { ChevronRight } from 'lucide-react';
import type { Task, TaskGroup } from './types';
import { getTaskTypeInfo, getStatusPill, formatRelativeTime, formatDuration } from './utils.tsx';
import { TaskTypeBadge } from './TaskTypeBadge';

interface ParentTaskRowProps {
  group: TaskGroup;
  task: Task;
  onRowClick: (taskId: string) => void;
}

export const ParentTaskRow: React.FC<ParentTaskRowProps> = ({ group, task, onRowClick }) => {
  const typeInfo = getTaskTypeInfo(task);

  return (
    <tr
      className="hover:bg-gray-50 transition-colors cursor-pointer group bg-white"
      onClick={() => onRowClick(task.id)}
    >
      <td className="py-3 px-4 align-top">
        <div className="flex flex-col">
          <span className="text-xs text-gray-400 font-normal">{group.repoOwner}</span>
          <span className="text-sm font-bold text-gray-800">{group.repoName}</span>
        </div>
      </td>
      <td className="py-3 px-4 align-top">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            {group.issueNumber ? (
              <span className="text-sm font-bold text-primary-600 hover:text-primary-700">
                PR #{group.issueNumber}
              </span>
            ) : (
              <span className="text-sm font-bold text-gray-700">Task {task.id.substring(0, 8)}</span>
            )}
            <TaskTypeBadge type={typeInfo.type} />
          </div>
          <div className="text-sm text-gray-900 font-medium">
            {(() => {
              // For followup tasks, prefer subtitle if available
              if (typeInfo.type === 'followup' && task.subtitle) {
                return task.subtitle;
              }
              // Otherwise use the clean title
              return typeInfo.cleanTitle || task.subtitle || 'No title';
            })()}
          </div>
          {(() => {
            // Show agent/model info if available
            const agent = task.llmProvider || '';
            const model = task.model || task.modelName || '';
            if (agent || model) {
              return (
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  {agent && <span className="font-medium">{agent}</span>}
                  {agent && model && <span>•</span>}
                  {model && <span>{model}</span>}
                </div>
              );
            }
            return null;
          })()}
        </div>
      </td>
      <td className="py-3 px-4 align-top">
        {getStatusPill(task.status)}
      </td>
      <td className="py-3 px-4 align-top text-sm text-gray-500 whitespace-nowrap" title={new Date(task.createdAt).toLocaleString()}>
        {formatRelativeTime(task.createdAt)}
      </td>
      <td className="py-3 px-4 align-top text-sm text-gray-600 font-mono whitespace-nowrap">
        {formatDuration(task.processedAt || task.createdAt, task.completedAt)}
      </td>
      <td className="py-3 px-4 align-top text-right">
        <button className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors">
          <ChevronRight size={16} />
        </button>
      </td>
    </tr>
  );
};

interface ChildTaskRowProps {
  task: Task;
  onRowClick: (taskId: string) => void;
}

export const ChildTaskRow: React.FC<ChildTaskRowProps> = ({ task, onRowClick }) => {
  const childTypeInfo = getTaskTypeInfo(task);
  const childDisplayTitle = (() => {
    // For followup tasks, prefer subtitle if available
    if (childTypeInfo.type === 'followup' && task.subtitle) {
      return task.subtitle;
    }
    // Otherwise use the clean title
    return childTypeInfo.cleanTitle || task.subtitle || 'Update';
  })();

  return (
    <tr
      className="hover:bg-gray-50 transition-colors cursor-pointer bg-gray-50/30"
      onClick={() => onRowClick(task.id)}
    >
      <td className="py-2 px-4 align-top relative">
         {/* Visual connector line placeholder if we wanted one spanning rows */}
      </td>
      <td className="py-2 px-4 align-top">
        <div className="flex flex-col gap-1 pl-2">
          <div className="flex items-start gap-2">
            <span className="text-gray-300 font-light select-none">└─</span>
            <span className="text-sm text-gray-600 line-clamp-1">{childDisplayTitle}</span>
          </div>
          {(() => {
            // Show agent/model info if available
            const agent = task.llmProvider || '';
            const model = task.model || task.modelName || '';
            if (agent || model) {
              return (
                <div className="flex items-center gap-2 text-xs text-gray-500 ml-5">
                  {agent && <span className="font-medium">{agent}</span>}
                  {agent && model && <span>•</span>}
                  {model && <span>{model}</span>}
                </div>
              );
            }
            return null;
          })()}
        </div>
      </td>
      <td className="py-2 px-4 align-top">
        {getStatusPill(task.status)}
      </td>
      <td className="py-2 px-4 align-top text-sm text-gray-500 whitespace-nowrap" title={new Date(task.createdAt).toLocaleString()}>
        {formatRelativeTime(task.createdAt)}
      </td>
      <td className="py-2 px-4 align-top text-sm text-gray-600 font-mono whitespace-nowrap">
        {formatDuration(task.processedAt || task.createdAt, task.completedAt)}
      </td>
      <td className="py-2 px-4 align-top text-right">
         <button className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors">
            <ChevronRight size={16} />
         </button>
      </td>
    </tr>
  );
};

interface CollapseToggleRowProps {
  groupKey: string;
  hiddenCount: number;
  onToggle: (groupKey: string, e: React.MouseEvent) => void;
}

export const CollapseToggleRow: React.FC<CollapseToggleRowProps> = ({ groupKey, hiddenCount, onToggle }) => (
  <tr className="bg-gray-50/30">
    <td className="p-0 border-r border-transparent">
       <div className="h-full w-full border-r-2 border-transparent"></div>
    </td>
    <td colSpan={5} className="py-1 px-4 text-xs">
       <button
         onClick={(e) => onToggle(groupKey, e)}
         className="flex items-center gap-1 text-primary-600 hover:text-primary-700 font-medium py-1 px-2 hover:bg-blue-50 rounded transition-colors ml-6"
       >
         <span className="text-lg leading-none opacity-40">↳</span>
         Show {hiddenCount} older updates...
       </button>
    </td>
  </tr>
);
