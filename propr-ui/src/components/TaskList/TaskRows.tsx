import { PreviewThumbnails } from '../PreviewMedia';
import React from 'react';
import { ChevronRight } from 'lucide-react';
import type { Task, TaskGroup } from './types';
import { getTaskTypeInfo, getStatusPill, formatRelativeTime, formatDuration, shouldDimTask, getParentDisplayTitle, getChildDisplayTitle } from './utils.tsx';
import { TaskTypeBadge } from './TaskTypeBadge';
import { ScoreBadge } from './ScoreBadge';
import { ProviderLogo } from '../ui/ProviderLogo';
import { TaskReferenceChips } from './ReferenceChips';
import { getModelDisplayName } from '../../utils/modelDisplay';

interface ParentTaskRowProps {
  group: TaskGroup;
  desktopLayout?: boolean;
  task: Task;
  onRowClick: (taskId: string) => void;
  isDuplicateRepo?: boolean;
}

// Prefer catalog labels (including version punctuation), with a readable fallback
// for custom models. The logo already identifies the provider.
const getTaskModelLabel = (model: string, provider: string): string => {
  if (!model) return provider;
  const name = getModelDisplayName(model, { compactAntigravity: true });
  const label = name.replace(/^(?:claude|anthropic|openai|google|opencode|antigravity)[ /-]+/i, '');
  return name === model
    ? label.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, letter => letter.toUpperCase())
    : label;
};

// Keep text selection and nested controls independent of the row click target.
const openDesktopRow = (event: React.MouseEvent, taskId: string, onRowClick: (id: string) => void) => {
  if ((event.target as Element).closest('a, button, input, select, textarea, [role="button"]')) return;
  if (window.getSelection()?.toString()) return;
  onRowClick(taskId);
};

const TaskTitle: React.FC<{ title: string; taskId: string; desktopLayout: boolean; onRowClick: (id: string) => void }> = ({ title, taskId, desktopLayout, onRowClick }) => desktopLayout ? (
  <button
    type="button"
    className="task-title"
    onClick={event => {
      event.stopPropagation();
      if (event.detail > 0 && window.getSelection()?.toString()) return;
      onRowClick(taskId);
    }}
  >
    {title}
  </button>
) : <>{title}</>;

/**
 * Trailing meta locked to a fixed column grid so the status pill, score, and
 * timestamp never shift horizontally between rows (a missing score keeps its slot).
 */
const TaskMetaCells: React.FC<{ task: Task; isDimmed: boolean }> = ({ task, isDimmed }) => (
  <>
    <td className="task-status py-3 px-4 align-top">
      <div className="task-meta-grid grid grid-cols-[7rem_3.5rem] items-center">
        <div className="task-meta-status w-28 flex justify-start">{getStatusPill(task.status)}</div>
        <div className="task-meta-score w-14 flex justify-center">
          <ScoreBadge score={task.critiqueScore} dimmed={isDimmed} />
        </div>
      </div>
    </td>
    <td className="task-metadata w-24 py-3 px-4 align-top text-right whitespace-nowrap">
      <div className="text-sm text-gray-800 tabular-nums" title={new Date(task.createdAt).toLocaleString()}>
        {formatRelativeTime(task.createdAt)}
      </div>
      <div className="text-xs text-slate-400 font-mono">
        {formatDuration(task.processedAt || task.createdAt, task.completedAt)}
      </div>
    </td>
  </>
);

export const ParentTaskRow: React.FC<ParentTaskRowProps> = ({ group, task, onRowClick, isDuplicateRepo = false, desktopLayout = false }) => {
  const typeInfo = getTaskTypeInfo(task);
  const isDimmed = shouldDimTask(task);

  return (
    <tr
      className="hover:bg-gray-50 transition-colors cursor-pointer group bg-white border-b border-slate-100"
      onClick={event => desktopLayout ? openDesktopRow(event, task.id, onRowClick) : onRowClick(task.id)}
    >
      <td className="task-repository py-3 px-6 align-top">
        {!isDuplicateRepo && <div className="flex flex-col">
          <span className="text-xs text-gray-400 font-normal">{group.repoOwner}</span>
          <span className="text-sm font-bold text-gray-800">{group.repoName}</span>
        </div>}
      </td>
      <td className="task-summary py-3 px-4 align-top">
        <div className="flex flex-col gap-1">
          {desktopLayout && <div className="task-inline-repository">{group.repoOwner}/{group.repoName}</div>}
          <div className="task-badges flex flex-wrap items-center gap-1.5">
            <TaskReferenceChips task={task} prNumber={group.prNumber} />
            <TaskTypeBadge type={typeInfo.type} label={typeInfo.workflowLabel} />
          </div>
          <div className="text-sm text-gray-900 font-medium">
            <TaskTitle
              title={getParentDisplayTitle(task)}
              taskId={task.id}
              desktopLayout={desktopLayout}
              onRowClick={onRowClick}
            />
          </div>
          <PreviewThumbnails media={task.previewMedia} />
          {(() => {
            // Show agent/model info if available
            const agent = task.llmProvider || '';
            const model = task.model || task.modelName || '';
            if (agent || model) {
              const displayText = getTaskModelLabel(model, agent);
              return (
                <div className="flex items-center gap-1 text-xs">
                  <span className="task-model inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-gray-100 text-gray-600 border border-gray-200">
                    <ProviderLogo provider={agent} className="w-3.5 h-3.5" />
                    <span>{displayText}</span>
                  </span>
                </div>
              );
            }
            return null;
          })()}
        </div>
      </td>
      <TaskMetaCells task={task} isDimmed={isDimmed} />
      {!desktopLayout && <td className="py-3 px-6 align-top text-right">
        <button className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors opacity-0 group-hover:opacity-100">
          <ChevronRight size={16} />
        </button>
      </td>}
    </tr>
  );
};

interface ChildTaskRowProps {
  desktopLayout?: boolean;
  task: Task;
  onRowClick: (taskId: string) => void;
}

interface ChildTaskRowExtraProps extends ChildTaskRowProps {
  isLastChild?: boolean;
}

export const ChildTaskRow: React.FC<ChildTaskRowExtraProps> = ({ task, onRowClick, isLastChild = false, desktopLayout = false }) => {
  const childTypeInfo = getTaskTypeInfo(task);
  const isDimmed = shouldDimTask(task);
  // Children show the delta (the specific fix/review/follow-up request), never the parent PR title.
  const childDisplayTitle = getChildDisplayTitle(task);

  return (
    <tr
      className="hover:bg-gray-50 transition-colors cursor-pointer bg-gray-50/30 group border-b border-slate-100"
      onClick={event => desktopLayout ? openDesktopRow(event, task.id, onRowClick) : onRowClick(task.id)}
    >
      <td className="task-repository py-3 px-6 align-top relative">
         {/* Visual connector line placeholder if we wanted one spanning rows */}
      </td>
      <td className="task-summary py-0 px-4 align-top relative">
        <div className="relative flex flex-col gap-1 pl-6 py-3">
          {!isLastChild && <div aria-hidden="true" className="absolute left-2 -top-px -bottom-px w-0.5 bg-gray-200" />}
          <div className="task-thread-anchor task-badges relative flex flex-wrap items-center gap-1.5 ml-4">
            <TaskReferenceChips task={task} prNumber={task.prNumber} />
            <TaskTypeBadge type={childTypeInfo.type} label={childTypeInfo.workflowLabel} />
          </div>
          <div className="flex items-start gap-2 pl-4">
            <span className={`text-sm text-gray-600 ${desktopLayout ? 'min-w-0' : 'line-clamp-1'}`}><TaskTitle title={childDisplayTitle} taskId={task.id} desktopLayout={desktopLayout} onRowClick={onRowClick} /></span>
          </div>
          <PreviewThumbnails media={task.previewMedia} />
          {(() => {
            // Show agent/model info if available
            const agent = task.llmProvider || '';
            const model = task.model || task.modelName || '';
            if (agent || model) {
              const displayText = getTaskModelLabel(model, agent);
              return (
                <div className="flex items-center gap-1 text-xs pl-4">
                  <span className="task-model inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-gray-100 text-gray-600 border border-gray-200">
                    <ProviderLogo provider={agent} className="w-3.5 h-3.5" />
                    <span>{displayText}</span>
                  </span>
                </div>
              );
            }
            return null;
          })()}
        </div>
      </td>
      <TaskMetaCells task={task} isDimmed={isDimmed} />
      {!desktopLayout && <td className="py-3 px-6 align-top text-right">
         <button className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors opacity-0 group-hover:opacity-100">
            <ChevronRight size={16} />
         </button>
      </td>}
    </tr>
  );
};

interface CollapseToggleRowProps {
  desktopLayout?: boolean;
  groupKey: string;
  hiddenCount: number;
  onToggle: (groupKey: string, e: React.MouseEvent) => void;
}

export const CollapseToggleRow: React.FC<CollapseToggleRowProps> = ({ groupKey, hiddenCount, onToggle, desktopLayout = false }) => (
  <tr className="bg-gray-50/30 border-b border-slate-100">
    <td className="task-repository py-3 px-6 align-top relative">
       {/* Empty cell for repository column alignment */}
    </td>
    <td colSpan={desktopLayout ? 3 : 4} className="py-0 px-4 align-top text-xs relative">
       <div className="pl-6 py-3">
         <div className="task-thread-anchor relative ml-4">
         <button
           onClick={(e) => onToggle(groupKey, e)}
           className="flex items-center gap-1 text-blue-600 hover:text-blue-700 font-medium py-1 px-2 hover:bg-blue-50 rounded transition-colors"
         >
           Show {hiddenCount} older updates...
         </button>
         </div>
       </div>
    </td>
  </tr>
);
