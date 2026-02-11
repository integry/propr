import React from 'react';
import { ChevronRight } from 'lucide-react';
import type { Task, TaskGroup } from './types';
import { getTaskTypeInfo, getStatusPill, formatRelativeTime, formatDuration } from './utils.tsx';
import { TaskTypeBadge } from './TaskTypeBadge';
import { ProviderLogo } from '../ui/ProviderLogo';

interface ParentTaskRowProps {
  group: TaskGroup;
  task: Task;
  onRowClick: (taskId: string) => void;
}

export const ParentTaskRow: React.FC<ParentTaskRowProps> = ({ group, task, onRowClick }) => {
  const typeInfo = getTaskTypeInfo(task);

  // Determine the display title
  const displayTitle = (() => {
    if (typeInfo.type === 'followup' && task.subtitle) {
      return task.subtitle;
    }
    return typeInfo.cleanTitle || task.subtitle || 'No title';
  })();

  // Get agent/model info
  const agent = task.llmProvider || '';
  const model = task.model || task.modelName || '';
  const displayModel = agent && model ? `${agent} ${model}` : agent || model;

  return (
    <div
      className="flex items-start gap-4 px-4 py-3 hover:bg-gray-50 transition-colors cursor-pointer group"
      onClick={() => onRowClick(task.id)}
    >
      {/* Main Content */}
      <div className="flex-1 min-w-0">
        {/* Line 1: Repo Name > Issue Title (Bold) */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-bold text-gray-900">
            {group.repoName}
          </span>
          <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />
          <span className="text-sm font-bold text-gray-900 truncate">
            {displayTitle}
          </span>
        </div>

        {/* Line 2: ID (Monospace Chip) | Status | Model | Time */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Issue/PR ID as Monospace Chip */}
          {group.prNumber ? (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-xs font-mono text-gray-700 border border-gray-200">
              PR #{group.prNumber}
            </span>
          ) : task.issueNumber ? (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-xs font-mono text-gray-700 border border-gray-200">
              #{task.issueNumber}
            </span>
          ) : (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-xs font-mono text-gray-700 border border-gray-200">
              {task.id.substring(0, 8)}
            </span>
          )}

          {/* Task Type Badge */}
          <TaskTypeBadge type={typeInfo.type} />

          {/* Status Pill */}
          {getStatusPill(task.status)}

          {/* Model/Agent Info */}
          {displayModel && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-xs text-gray-600 border border-gray-200">
              <ProviderLogo provider={agent} className="w-3 h-3" />
              <span>{displayModel}</span>
            </span>
          )}

          {/* Time */}
          <span className="text-xs text-gray-500" title={new Date(task.createdAt).toLocaleString()}>
            {formatRelativeTime(task.createdAt)}
          </span>
          <span className="text-xs text-gray-400 font-mono">
            {formatDuration(task.processedAt || task.createdAt, task.completedAt)}
          </span>
        </div>
      </div>

      {/* Arrow */}
      <button className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0 self-center">
        <ChevronRight size={16} />
      </button>
    </div>
  );
};

interface ChildTaskRowProps {
  task: Task;
  onRowClick: (taskId: string) => void;
}

interface ChildTaskRowExtraProps extends ChildTaskRowProps {
  isLastChild?: boolean;
}

export const ChildTaskRow: React.FC<ChildTaskRowExtraProps> = ({ task, onRowClick, isLastChild = false }) => {
  const childTypeInfo = getTaskTypeInfo(task);
  const childDisplayTitle = (() => {
    if (childTypeInfo.type === 'followup' && task.subtitle) {
      return task.subtitle;
    }
    return childTypeInfo.cleanTitle || task.subtitle || 'Update';
  })();

  // Get agent/model info
  const agent = task.llmProvider || '';
  const model = task.model || task.modelName || '';
  const displayModel = agent && model ? `${agent} ${model}` : agent || model;

  return (
    <div
      className="flex items-start gap-4 px-4 py-3 hover:bg-gray-50 transition-colors cursor-pointer group bg-gray-50/30"
      onClick={() => onRowClick(task.id)}
    >
      {/* Threading Gutter */}
      <div className="relative w-6 flex-shrink-0 self-stretch">
        {/* Vertical line */}
        <div
          className={`absolute left-3 top-0 w-0.5 bg-gray-200 ${isLastChild ? 'h-5' : 'h-full'}`}
        />
        {/* Horizontal arm */}
        <div className="absolute left-3 top-5 w-3 h-0.5 bg-gray-200" />
      </div>

      {/* Main Content */}
      <div className="flex-1 min-w-0">
        {/* Line 1: Title (lighter weight for child) */}
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm text-gray-700 truncate">
            {childDisplayTitle}
          </span>
        </div>

        {/* Line 2: Status | Model | Time */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Status Pill */}
          {getStatusPill(task.status)}

          {/* Model/Agent Info */}
          {displayModel && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-xs text-gray-600 border border-gray-200">
              <ProviderLogo provider={agent} className="w-3 h-3" />
              <span>{displayModel}</span>
            </span>
          )}

          {/* Time */}
          <span className="text-xs text-gray-500" title={new Date(task.createdAt).toLocaleString()}>
            {formatRelativeTime(task.createdAt)}
          </span>
          <span className="text-xs text-gray-400 font-mono">
            {formatDuration(task.processedAt || task.createdAt, task.completedAt)}
          </span>
        </div>
      </div>

      {/* Arrow */}
      <button className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0 self-center">
        <ChevronRight size={16} />
      </button>
    </div>
  );
};

interface CollapseToggleRowProps {
  groupKey: string;
  hiddenCount: number;
  onToggle: (groupKey: string, e: React.MouseEvent) => void;
}

export const CollapseToggleRow: React.FC<CollapseToggleRowProps> = ({ groupKey, hiddenCount, onToggle }) => (
  <div className="flex items-center gap-4 px-4 py-2 bg-gray-50/30">
    {/* Threading Gutter */}
    <div className="relative w-6 flex-shrink-0">
      {/* Vertical line */}
      <div className="absolute left-3 top-0 w-0.5 h-4 bg-gray-200" />
      {/* Horizontal arm */}
      <div className="absolute left-3 top-4 w-3 h-0.5 bg-gray-200" />
    </div>

    {/* Expand Button */}
    <button
      onClick={(e) => onToggle(groupKey, e)}
      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium py-1 px-2 hover:bg-blue-50 rounded transition-colors"
    >
      Show {hiddenCount} older updates...
    </button>
  </div>
);
