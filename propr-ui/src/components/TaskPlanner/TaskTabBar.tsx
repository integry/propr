import React from 'react';
import { PanelLeftOpen } from 'lucide-react';
import { getOutlineTitle } from './planDisplayName';

/** Plans with fewer steps than this navigate with a tab bar instead of the outline rail. */
export const OUTLINE_RAIL_MIN_TASKS = 5;

interface TaskTabBarProps {
  taskTitles: string[];
  taskIds: string[];
  activeIndex: number;
  onSelect: (taskId: string, index: number) => void;
}

/**
 * Horizontal step navigation for short plans. A 2–4 step outline would leave
 * the rail mostly empty, so the steps sit above the specification instead and
 * the specification keeps the full reading width.
 */
export const TaskTabBar: React.FC<TaskTabBarProps> = ({ taskTitles, taskIds, activeIndex, onSelect }) => (
  // A fixed row above the specification's scroll container (not sticky inside it), so
  // specification content can never render above or through the tabs.
  <nav aria-label="Plan steps" className="relative z-10 flex-shrink-0 border-b border-slate-200 bg-white px-6">
    <ol className="flex min-w-0 gap-1 overflow-x-auto scrollbar-thin">
      {taskIds.map((id, index) => {
        const isActive = index === activeIndex;
        const title = getOutlineTitle(taskTitles[index] || `Step ${index + 1}`);
        return (
          <li key={id} className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => onSelect(id, index)}
              aria-current={isActive ? 'step' : undefined}
              title={title}
              className={`-mb-px flex h-full w-full min-w-0 items-baseline gap-1.5 border-b-2 px-3 py-2 text-left text-[13px] leading-snug transition-colors ${
                isActive
                  ? 'border-teal-600 font-medium text-slate-900'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'
              }`}
            >
              <span className={`flex-shrink-0 font-mono text-xs tabular-nums ${isActive ? 'text-teal-700' : 'text-slate-400'}`}>{index + 1}.</span>
              {/* Wraps to a second line instead of cutting the title off after a few words. */}
              <span className="line-clamp-2 break-words">{title}</span>
            </button>
          </li>
        );
      })}
    </ol>
  </nav>
);

/** The outline rail once collapsed: a narrow strip that only offers to reopen it. */
export const CollapsedOutlineRail: React.FC<{ activeIndex: number; taskCount: number; onExpand: () => void }> = ({
  activeIndex,
  taskCount,
  onExpand,
}) => (
  <div className="flex w-10 flex-shrink-0 flex-col items-center gap-2 border-r border-slate-200 bg-slate-50 pt-3">
    <button
      type="button"
      onClick={onExpand}
      aria-label="Show outline"
      title="Show outline"
      className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
    >
      <PanelLeftOpen size={16} />
    </button>
    <span className="text-[11px] tabular-nums text-slate-400 [writing-mode:vertical-rl]">
      {activeIndex + 1} / {taskCount}
    </span>
  </div>
);
