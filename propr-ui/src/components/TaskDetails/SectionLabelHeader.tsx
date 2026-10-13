import React from 'react';
import { RefreshCw } from 'lucide-react';
import { InspectedRunContext, type RunInspection } from './TaskHeader';

/** What the run's log is: a review's evaluation, or the trace of an agent changing code. */
function getSectionLabel(commandMode: string | undefined): string {
  return commandMode === 'review' ? 'REVIEW FINDINGS' : 'EXECUTION TRACE';
}

interface SectionLabelHeaderProps {
  commandMode: string | undefined;
  ultrafixCycle?: boolean;
  className?: string;
  /** Set when the panel shows an earlier run than the task's newest. */
  inspection?: RunInspection | null;
  /** Human-readable steps in the log. */
  stepCount?: number;
}

/** The log's one header: what kind of log it is, how many steps it holds, and which run it shows. */
const SectionLabelHeader: React.FC<SectionLabelHeaderProps> = ({ commandMode, ultrafixCycle, className, inspection, stepCount }) => {
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
    </div>
  );
};

export default SectionLabelHeader;
