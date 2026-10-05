import React from 'react';
import { FileText, RefreshCw, Terminal } from 'lucide-react';
import { InspectedRunContext, type RunInspection } from './TaskHeader';

export type LogView = 'readable' | 'terminal';

/** What the run's log is: a review's evaluation, or the trace of an agent changing code. */
function getSectionLabel(commandMode: string | undefined): string {
  return commandMode === 'review' ? 'REVIEW FINDINGS' : 'EXECUTION TRACE';
}

/** Clicks inside this marker don't count as "outside" the raw terminal drawer they control. */
export const EXECUTION_LOG_CONTROL_ATTRIBUTE = 'data-execution-log-control';

const viewButton = 'inline-flex h-6 items-center gap-1 rounded px-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';

interface SectionLabelHeaderProps {
  commandMode: string | undefined;
  ultrafixCycle?: boolean;
  className?: string;
  /** Set when the panel shows an earlier run than the task's newest. */
  inspection?: RunInspection | null;
  /** Human-readable steps in the log. */
  stepCount?: number;
  /** Which view of the log is on screen; with `onViewChange`, the header offers the switch. */
  view?: LogView;
  onViewChange?: (view: LogView) => void;
}

/** The log's one header: what kind of log it is, how many steps it holds, and the switch to the raw terminal. */
const SectionLabelHeader: React.FC<SectionLabelHeaderProps> = ({ commandMode, ultrafixCycle, className, inspection, stepCount, view = 'readable', onViewChange }) => {
  const label = getSectionLabel(commandMode);
  return (
    <div className={className}>
      <div className="flex min-w-0 flex-1 items-center gap-2 py-2">
        <h3 className="m-0 flex-none text-[11px] font-bold uppercase tracking-widest text-slate-500">
          {label}
        </h3>
        {ultrafixCycle && (
          <span className="inline-flex flex-none items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-violet-50 text-violet-600">
            <RefreshCw className="h-3 w-3" />
            Ultrafix
          </span>
        )}
        {stepCount !== undefined && stepCount > 0 && (
          <span data-testid="log-step-count" className="flex-none rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-500">
            {stepCount} {stepCount === 1 ? 'step' : 'steps'}
          </span>
        )}
        {inspection && <InspectedRunContext {...inspection} />}
      </div>
      {onViewChange && (
        <div
          role="group"
          aria-label="Log view"
          {...{ [EXECUTION_LOG_CONTROL_ATTRIBUTE]: '' }}
          className="ml-auto inline-flex flex-none rounded-md border border-slate-200 bg-slate-50 p-0.5"
        >
          <button
            type="button"
            aria-pressed={view === 'readable'}
            onClick={() => onViewChange('readable')}
            className={`${viewButton} ${view === 'readable' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            Human readable
          </button>
          <button
            type="button"
            aria-pressed={view === 'terminal'}
            onClick={() => onViewChange('terminal')}
            className={`${viewButton} ${view === 'terminal' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
            Raw
          </button>
        </div>
      )}
    </div>
  );
};

export default SectionLabelHeader;
