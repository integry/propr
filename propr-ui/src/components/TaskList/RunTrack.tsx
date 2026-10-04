import React from 'react';
import { describeRun, RUN_TRACK_LIMIT, type RunOutcome, type TaskRunEntry } from './rowModel';

/**
 * A run's outcome as a shape and a colour, so it reads without colour too:
 * a red triangle for a failure, an amber square for a review that left
 * findings (6/10 or lower), a slate dot for a pass or a merge, a pulsing teal
 * dot for a run in flight, and a hollow ring for a run that was stopped.
 */
export const RunOutcomeMarker: React.FC<{ outcome: RunOutcome; size?: 'sm' | 'md' }> = ({ outcome, size = 'sm' }) => {
  const box = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';
  switch (outcome) {
    case 'failed':
      return (
        <svg data-outcome={outcome} viewBox="0 0 10 10" className={`${box} flex-none text-red-500`} aria-hidden="true">
          <path d="M5 0.5 9.6 9.5H0.4Z" fill="currentColor" />
        </svg>
      );
    case 'findings':
      return <span data-outcome={outcome} aria-hidden="true" className={`${box} flex-none rounded-[1px] bg-amber-500`} />;
    case 'active':
      return (
        <span data-outcome={outcome} aria-hidden="true" className={`relative flex ${box} flex-none`}>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
          <span className={`relative inline-flex ${box} rounded-full bg-teal-500`} />
        </span>
      );
    case 'stopped':
      return <span data-outcome={outcome} aria-hidden="true" className={`${box} flex-none rounded-full border border-slate-400 bg-white`} />;
    default:
      return <span data-outcome={outcome} aria-hidden="true" className={`${box} flex-none rounded-full bg-slate-400`} />;
  }
};

/**
 * The trend of a task's runs on its list card: `+4 ●─■─■─⟳`. Never more than
 * the newest four, joined by a 1px rail and set on a quiet slate pill, so a
 * row of identical dots reads as a track rather than a masked password. The
 * older runs are counted inside the pill; the task pane's timeline carries
 * every run in full.
 */
export const RunTrack: React.FC<{ runs: TaskRunEntry[] }> = ({ runs }) => {
  const shown = runs.slice(-RUN_TRACK_LIMIT);
  const hidden = runs.length - shown.length;
  return (
    <span data-testid="run-track" className="inline-flex flex-none items-center gap-1.5 rounded-sm bg-slate-100/70 px-1.5 py-0.5">
      {hidden > 0 && (
        <span data-testid="run-track-overflow" className="font-mono text-[10px] leading-4 text-slate-500">
          +{hidden}
        </span>
      )}
      <span className="inline-flex items-center">
        {shown.map((run, index) => (
          <React.Fragment key={run.task.id}>
            {index > 0 && <span aria-hidden="true" className="h-px w-2 bg-slate-300" />}
            <span title={describeRun(run)} className="inline-flex"><RunOutcomeMarker outcome={run.outcome} /></span>
          </React.Fragment>
        ))}
      </span>
    </span>
  );
};
