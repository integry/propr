import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, GitCommit } from 'lucide-react';
import { WorkTypeBadge } from '../Dashboard/sectionPrimitives';
import { ScoreBadge } from '../TaskList/ScoreBadge';
import { formatDuration, formatRelativeTime } from '../TaskList/utils.tsx';
import { describeRun, isReviewRun, runScore, type TaskRunEntry } from '../TaskList/rowModel';
import { RUN_DURATION_COLUMN, RUN_NUMBER_COLUMN, RUN_TAG_COLUMN, RUN_TIME_COLUMN } from './runTimelineColumns';

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
 * What a run produced, after its summary. A review scores the code; a failed
 * run says so, since the rail's nodes carry no colour. A fix writes code, so
 * its commit is the detail: shown once the run is open, or while the row is
 * hovered, so a closed row gives that room to its summary instead.
 */
const RunResult: React.FC<{ run: TaskRunEntry; open: boolean }> = ({ run, open }) => {
  if (run.outcome === 'active') {
    return <span className="flex-none rounded-full bg-teal-50 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-teal-700">Active</span>;
  }
  if (run.outcome === 'waiting') {
    return <span className="flex-none rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">Waiting</span>;
  }
  if (isReviewRun(run.type)) {
    return <ScoreBadge score={runScore(run)} bracketed className="flex-none !text-xs" label="Review score" />;
  }
  if (run.task.commitHash) {
    return (
      <span
        data-testid="run-commit"
        title={`Commit ${run.task.commitHash}`}
        className={`${open ? 'inline-flex' : 'hidden group-hover:inline-flex group-focus-visible:inline-flex'} flex-none items-center gap-1 font-mono text-[11px] text-slate-500`}
      >
        <GitCommit aria-hidden="true" className="h-3 w-3 flex-none text-slate-400" strokeWidth={2.25} />
        {run.task.commitHash.slice(0, 7)}
      </span>
    );
  }
  if (run.outcome === 'failed') return <span className="flex-none text-[11px] font-medium text-red-600">Failed</span>;
  return null;
};

/**
 * The history of the whole task: one row per run, on a continuous 2px rail.
 * Earlier runs are single-line summaries (number, type, what it did and its
 * result, when, how long); the run the pane shows is
 * open, its steps branching off the rail. The rail's nodes are plain: the type
 * and the result slot already say what each run was and how it went. Choosing another run opens it in the pane, so the files changed and
 * the execution log below follow it: the timeline is how the pane moves
 * through the task's history.
 */
/** Room left above the open run when the list scrolls to it, so the run before it stays in sight. */
const SCROLL_CONTEXT_PX = 40;

const RunTimeline: React.FC<RunTimelineProps> = ({ runs, selectedTaskId, onSelectRun, children }) => {
  const [expanded, setExpanded] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLLIElement>(null);

  // A task with many runs opens on the one shown, not on its first run. Only
  // the list scrolls: the page around it stays where it is.
  useEffect(() => {
    const list = scrollRef.current;
    const run = selectedRef.current;
    if (!list || !run) return;
    const offset = run.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop = Math.max(0, list.scrollTop + offset - SCROLL_CONTEXT_PX);
  }, [selectedTaskId]);

  // Bounded, so 50 runs scroll inside the timeline instead of pushing the files changed off the screen.
  return (
    <div ref={scrollRef} data-testid="run-timeline-scroll" className="scrollbar-stealth max-h-[420px] overflow-y-auto overscroll-contain pr-1">
      <ol aria-label="Runs" className="relative m-0 list-none p-0" data-testid="run-timeline">
        {/* The trunk paints above the rows, so an open run's tinted row and its steps never cut it. */}
        <span aria-hidden="true" data-testid="run-timeline-trunk" className="pointer-events-none absolute bottom-3 left-[7px] top-3 z-[1] w-0.5 bg-slate-300" />
        {runs.map(run => {
          const selected = run.task.id === selectedTaskId;
          const open = selected && expanded;
          const active = run.outcome === 'active';
          // A queued run has not started, so it has no runtime to count yet.
          const waiting = run.outcome === 'waiting';
          return (
            <li key={run.task.id} ref={selected ? selectedRef : undefined} className="relative" data-testid="run-timeline-run">
              <button
                type="button"
                aria-current={selected || undefined}
                aria-expanded={open}
                title={describeRun(run)}
                onClick={() => (selected ? setExpanded(value => !value) : onSelectRun(run.task.id))}
                className={`group flex w-full min-w-0 items-center gap-2 rounded-sm py-1.5 pr-1 text-left text-xs leading-5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 ${selected ? 'bg-slate-100/80' : 'hover:bg-slate-50'}`}
              >
                {/* A plain node on the rail, on the row's own background. */}
                <span className="relative z-[2] mr-1 flex h-4 w-4 flex-none items-center justify-center">
                  <span
                    aria-hidden="true"
                    data-testid="run-timeline-node"
                    className={`h-2 w-2 rounded-full border-2 ${selected ? 'border-slate-500 bg-slate-500' : 'border-slate-300 bg-white'}`}
                  />
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className={`h-3 w-3 flex-none text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
                  strokeWidth={2.5}
                />
                {/* A fixed tag column, so every summary, and its steps' labels, start on one line. */}
                <span className={`flex ${RUN_TAG_COLUMN} flex-none items-center gap-2`}>
                  <span className={`${RUN_NUMBER_COLUMN} flex-none whitespace-nowrap ${selected ? 'font-semibold text-slate-900' : 'font-medium text-slate-700'}`}>
                    Run {run.number}
                  </span>
                  {run.type && <WorkTypeBadge type={run.type} compact />}
                </span>
                <span className={`min-w-0 flex-1 truncate ${selected ? 'text-slate-800' : 'text-slate-600'}`} title={run.summary}>{run.summary}</span>
                {/* Sized to what it holds: a closed fix shows nothing here, so its summary runs on to the time. */}
                <RunResult run={run} open={open} />
                {/* Fixed and right-aligned, so the results before it line up down the list. */}
                <time
                  dateTime={run.task.createdAt}
                  title={new Date(run.task.createdAt).toLocaleString()}
                  className={`${RUN_TIME_COLUMN} flex-none whitespace-nowrap text-right tabular-nums text-slate-400`}
                >
                  {formatRelativeTime(run.task.createdAt)}
                </time>
                <span className={`${RUN_DURATION_COLUMN} flex-none whitespace-nowrap text-right font-mono text-[11px] tabular-nums ${active ? 'font-medium text-teal-700' : 'text-slate-500'}`}>
                  {active ? 'Running…' : waiting ? 'Queued' : formatDuration(run.task.processedAt || run.task.createdAt, run.task.completedAt)}
                </span>
              </button>
              {open && <div className="pb-1" data-testid="run-timeline-steps">{children}</div>}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export default RunTimeline;
