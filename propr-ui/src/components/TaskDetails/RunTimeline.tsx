import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, GitCommit } from 'lucide-react';
import { WorkTypeBadge } from '../Dashboard/sectionPrimitives';
import { ScoreBadge } from '../TaskList/ScoreBadge';
import { formatDuration, formatRelativeTime } from '../TaskList/utils.tsx';
import { describeRun, isReviewRun, runScore, type TaskRunEntry } from '../TaskList/rowModel';
import PullRequestOutcomeEntry from './PullRequestOutcomeEntry';
import ReviewScoreHistory from './ReviewScoreHistory';
import type { PullRequestScoresResponse } from '../../api/taskStatsApi';
import type { PullRequestOutcome } from './pullRequestScores';
import { RUN_DURATION_COLUMN, RUN_LEAD_INSET_PHONE, RUN_NUMBER_COLUMN, RUN_SUMMARY_MIN_WIDTH, RUN_TAG_COLUMN, RUN_TIME_COLUMN } from './runTimelineColumns';

export type RunRevealHistory = React.RefObject<{ group: string; selected: string } | null>;

interface RunTimelineProps {
  revealHistory?: RunRevealHistory;
  /** Every run of the task, oldest first. */
  runs: TaskRunEntry[];
  /** The run the pane shows: its steps hang under its row, and the panels below describe it. */
  selectedTaskId: string;
  onSelectRun: (taskId: string) => void;
  /** The selected run's steps, drawn under its row. */
  children: React.ReactNode;
  /** The pull request's review scores: a milestone on the trunk after every run, before where the PR ended. */
  reviewScores?: { prNumber: number; history: PullRequestScoresResponse | null } | null;
  /** Where the task's pull request ended, if it has: the timeline's last entry, after every run and review. */
  outcome?: PullRequestOutcome | null;
}

/** On a phone the result ends the run's second line: `30 mins ago  5m 00s  4be17c0`. */
const RESULT_LAST_ON_PHONE = 'max-sm:order-last';

/**
 * What a run produced, after its summary. A review scores the code; a failed
 * run says so, since the rail's nodes carry no colour. A fix writes code, so
 * its commit is the detail: shown once the run is open, or while the row is
 * hovered, so a closed row gives that room to its summary instead.
 */
const RunResult: React.FC<{ run: TaskRunEntry; open: boolean }> = ({ run, open }) => {
  if (run.outcome === 'active') {
    return <span className={`${RESULT_LAST_ON_PHONE} flex-none rounded-full bg-teal-50 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-teal-700`}>Active</span>;
  }
  if (run.outcome === 'waiting') {
    return <span className={`${RESULT_LAST_ON_PHONE} flex-none rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600`}>Waiting</span>;
  }
  if (isReviewRun(run.type)) {
    return <ScoreBadge score={runScore(run)} bracketed className={`${RESULT_LAST_ON_PHONE} flex-none !text-xs`} label="Review score" />;
  }
  if (run.task.commitHash) {
    return (
      <span
        data-testid="run-commit"
        title={`Commit ${run.task.commitHash}`}
        className={`${RESULT_LAST_ON_PHONE} ${open ? 'inline-flex' : 'hidden group-hover:inline-flex group-focus-visible:inline-flex'} flex-none items-center gap-1 font-mono text-[11px] text-slate-500`}
      >
        <GitCommit aria-hidden="true" className="h-3 w-3 flex-none text-slate-400" strokeWidth={2.25} />
        {run.task.commitHash.slice(0, 7)}
      </span>
    );
  }
  if (run.outcome === 'failed') return <span className={`${RESULT_LAST_ON_PHONE} flex-none text-[11px] font-medium text-red-600`}>Failed</span>;
  return null;
};

/**
 * The history of the whole task: one row per run, on a continuous 2px rail.
 * Earlier runs are single-line summaries (number, type, what it did and its
 * result, when, how long); the run the pane shows is
 * open, its steps branching off the rail. The rail's nodes are plain: the type
 * and the result slot already say what each run was and how it went. Choosing another run opens it in the pane, so the files changed and
 * the execution log below follow it: the timeline is how the pane moves
 * through the task's history. After the runs, the PR's review scores are a
 * milestone on the trunk; once the PR is merged or closed, that is the last entry.
 */
const RunTimeline: React.FC<RunTimelineProps> = ({ runs, selectedTaskId, onSelectRun, children, reviewScores, outcome, revealHistory }) => {
  const [expanded, setExpanded] = useState(true);

  const selectedRef = useRef<HTMLLIElement>(null);
  const localHistory = useRef<{ group: string; selected: string } | null>(null);
  const revealed = revealHistory ?? localHistory;
  useEffect(() => {
    const group = runs[0]?.task.id;
    if (!group || !selectedRef.current) return;
    if (revealed.current?.group === group && revealed.current.selected === selectedTaskId) return;
    const initialReveal = revealed.current?.group !== group;
    revealed.current = { group, selected: selectedTaskId };
    // Initial selection (including asynchronously loaded runs) preserves the task overview.
    // Only subsequent run switches reveal their header.
    if (initialReveal) return;
    const row = selectedRef.current;
    let scroller = row.parentElement;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const bounds = scroller?.getBoundingClientRect();
    const header = row.querySelector('button')?.getBoundingClientRect();
    const margin = parseFloat(getComputedStyle(row).scrollMarginTop) || 0;
    // The expanded steps can be taller than the viewport; only the header needs revealing.
    if (bounds && header && header.top >= bounds.top + margin && header.bottom <= bounds.bottom) return;
    row.scrollIntoView?.({ block: 'start' });
  }, [runs, selectedTaskId, revealed]);

  // Every run expands in the shared task workspace, together with the changed files.
  return (
    <div data-testid="run-timeline-scroll" className="pr-1">
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
            <li ref={selected ? selectedRef : undefined} key={run.task.id} className="relative scroll-mt-14 sm:scroll-mt-[3.75rem]" data-testid="run-timeline-run">
              <button
                type="button"
                aria-current={selected || undefined}
                aria-expanded={open}
                title={describeRun(run)}
                onClick={() => (selected ? setExpanded(value => !value) : onSelectRun(run.task.id))}
                className={`group flex w-full min-w-0 max-lg:min-h-11 [@media(any-pointer:coarse)]:min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-sm py-1.5 pr-1 text-left text-xs leading-5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 ${selected ? 'bg-slate-100/80' : 'hover:bg-slate-50'}`}
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
                {/* Keeps a readable width: when the row cannot also fit what follows, that wraps under it instead. */}
                <span className={`${RUN_SUMMARY_MIN_WIDTH} flex-1 truncate ${selected ? 'text-slate-800' : 'text-slate-600'}`} title={run.summary}>{run.summary}</span>
                {/* One unit, so on a narrow desktop pane the result, time and duration move together to a second
                    line, still ending on the row's right edge over the steps' durations. A phone always gives them
                    their own line, starting under `Run N` (`30 mins ago  5m 00s  4be17c0`), so line 1 keeps the summary. */}
                <span data-testid="run-timeline-meta" className={`ml-auto flex flex-none items-center gap-2 max-sm:ml-0 max-sm:basis-full ${RUN_LEAD_INSET_PHONE}`}>
                  {/* Sized to what it holds: a closed fix shows nothing here, so its summary runs on to the time. */}
                  <RunResult run={run} open={open} />
                  {/* Fixed and right-aligned, so the results before it line up down the list. */}
                  <time
                    dateTime={run.task.createdAt}
                    title={new Date(run.task.createdAt).toLocaleString()}
                    className={`${RUN_TIME_COLUMN} flex-none whitespace-nowrap text-right tabular-nums text-slate-400 max-sm:w-auto max-sm:text-left`}
                  >
                    {formatRelativeTime(run.task.createdAt)}
                  </time>
                  <span className={`${RUN_DURATION_COLUMN} flex-none whitespace-nowrap text-right font-mono text-[11px] tabular-nums max-sm:w-auto max-sm:text-left ${active ? 'font-medium text-teal-700' : 'text-slate-500'}`}>
                    {active ? 'Running…' : waiting ? 'Queued' : formatDuration(run.task.processedAt || run.task.createdAt, run.task.completedAt)}
                  </span>
                </span>
              </button>
              {open && <div className="pb-1" data-testid="run-timeline-steps">{children}</div>}
            </li>
          );
        })}
        {reviewScores && <ReviewScoreHistory prNumber={reviewScores.prNumber} history={reviewScores.history} variant="rail" />}
        {outcome && <PullRequestOutcomeEntry outcome={outcome} variant="rail" />}
      </ol>
    </div>
  );
};

export default RunTimeline;
