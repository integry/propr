import React, { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { buildRunOptions } from './rowModel';
import type { TaskGroup } from './types';

/**
 * The run open in the task pane, and a way to step back to earlier ones, as in
 * a CI provider's workflow runs: `Run 8 of 8 ▾`. The list row is the task;
 * this picks which of its runs the timeline, files and log describe. The
 * status badge beside the title already names the run's state, so the closed
 * control does not repeat it; the open list does, to tell the runs apart.
 *
 * A native select keeps the keyboard and screen-reader behaviour of the
 * platform; it sits transparent over the compact label, so the closed control
 * reads `Run 8 of 8` while the open list carries each run's summary.
 */
export const RunSwitcher: React.FC<{
  group: TaskGroup;
  selectedTaskId: string;
  onSelect: (taskId: string) => void;
}> = ({ group, selectedTaskId, onSelect }) => {
  const options = useMemo(() => buildRunOptions(group), [group]);
  const current = options.find(option => option.taskId === selectedTaskId);
  if (options.length < 2 || !current) return null;
  return (
    <label
      data-testid="run-switcher"
      className="relative inline-flex h-7 flex-none items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 focus-within:ring-2 focus-within:ring-teal-500"
    >
      <span aria-hidden="true">
        Run {current.number} of {options.length}
      </span>
      <ChevronDown className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
      <select
        aria-label="Run"
        value={current.taskId}
        onChange={event => onSelect(event.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
      >
        {options.map(option => (
          <option key={option.taskId} value={option.taskId}>
            Run {option.number} ({option.status}) — {option.summary}
          </option>
        ))}
      </select>
    </label>
  );
};
