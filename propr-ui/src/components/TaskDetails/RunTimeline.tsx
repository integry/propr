import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { WorkTypeBadge } from '../Dashboard/sectionPrimitives';
import { RunOutcomeMarker } from '../TaskList/RunTrack';
import { ScoreBadge } from '../TaskList/ScoreBadge';
import { formatDuration, formatRelativeTime } from '../TaskList/utils.tsx';
import { describeRun, type TaskRunEntry } from '../TaskList/rowModel';

interface RunTimelineProps {
  /** Every run of the task, oldest first. */
  runs: TaskRunEntry[];
  /** The run the pane shows: its steps hang under its row, and the panels below describe it. */
  selectedTaskId: string;
  onSelectRun: (taskId: string) => void;
  /** The selected run's steps, drawn under its row. */
  children: React.ReactNode;
}

/**
 * The history of the whole task: one row per run, on a continuous 2px rail.
 * Earlier runs are single-line summaries (number, type, what it did, when, how
 * long, score); the run the pane shows is open, its steps branching off the
 * rail. Choosing another run opens it in the pane, so the files changed and
 * the execution log below follow it: the timeline is how the pane moves
 * through the task's history.
 */
const RunTimeline: React.FC<RunTimelineProps> = ({ runs, selectedTaskId, onSelectRun, children }) => {
  const [expanded, setExpanded] = useState(true);
  const selectedRef = useRef<HTMLLIElement>(null);

  // A task with many runs opens on the one shown, not on its first run.
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);

  return (
    <ol aria-label="Runs" className="relative m-0 list-none p-0" data-testid="run-timeline">
      <span aria-hidden="true" className="absolute bottom-3 left-[7px] top-3 w-0.5 bg-slate-300" />
      {runs.map(run => {
        const selected = run.task.id === selectedTaskId;
        const open = selected && expanded;
        const active = run.outcome === 'active';
        return (
          <li key={run.task.id} ref={selected ? selectedRef : undefined} className="relative" data-testid="run-timeline-run">
            <button
              type="button"
              aria-current={selected || undefined}
              aria-expanded={open}
              title={describeRun(run)}
              onClick={() => (selected ? setExpanded(value => !value) : onSelectRun(run.task.id))}
              className={`flex w-full min-w-0 items-center gap-2 rounded-sm py-1.5 pr-1 text-left text-xs leading-5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 ${selected ? 'bg-slate-100/80' : 'hover:bg-slate-50'}`}
            >
              {/* The node sits on the rail; white behind it breaks the line around the marker. */}
              <span className="relative z-[1] flex h-4 w-4 flex-none items-center justify-center bg-white">
                <RunOutcomeMarker outcome={run.outcome} size="md" />
              </span>
              <ChevronRight
                aria-hidden="true"
                className={`h-3 w-3 flex-none text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
                strokeWidth={2.5}
              />
              <span className={`flex-none whitespace-nowrap ${selected ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'}`}>
                Run {run.number}
              </span>
              <span aria-hidden="true" className="flex-none text-slate-300">·</span>
              {run.type && <span className="flex-none"><WorkTypeBadge type={run.type} compact /></span>}
              <span className={`min-w-0 flex-1 truncate ${selected ? 'text-slate-800' : 'text-slate-600'}`} title={run.summary}>{run.summary}</span>
              <time
                dateTime={run.task.createdAt}
                title={new Date(run.task.createdAt).toLocaleString()}
                className="flex-none whitespace-nowrap tabular-nums text-slate-400"
              >
                {formatRelativeTime(run.task.createdAt)}
              </time>
              <span className={`w-16 flex-none whitespace-nowrap text-right font-mono text-[11px] tabular-nums ${active ? 'font-medium text-teal-700' : 'text-slate-500'}`}>
                {active ? 'Running…' : formatDuration(run.task.processedAt || run.task.createdAt, run.task.completedAt)}
              </span>
              {/* A fixed slot, so scores line up whether or not every run has one. */}
              <span className="flex w-12 flex-none justify-end">
                {active
                  ? <span className="rounded-full bg-teal-50 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-teal-700">Active</span>
                  : <ScoreBadge score={run.task.score} bracketed className="!text-xs" label="Run score" />}
              </span>
            </button>
            {open && <div className="pb-1" data-testid="run-timeline-steps">{children}</div>}
          </li>
        );
      })}
    </ol>
  );
};

export default RunTimeline;
