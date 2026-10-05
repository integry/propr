import React from 'react';
import { RefreshCw } from 'lucide-react';
import { InspectedRunContext, type RunInspection } from './TaskHeader';

function getSectionLabel(commandMode: string | undefined): string {
  if (commandMode === 'review') return 'REVIEW';
  if (commandMode === 'fix') return 'FIX';
  return 'IMPLEMENTATION';
}

interface SectionLabelHeaderProps {
  commandMode: string | undefined;
  ultrafixCycle?: boolean;
  className?: string;
  /** Set when the panel shows an earlier run than the task's newest. */
  inspection?: RunInspection | null;
}

const SectionLabelHeader: React.FC<SectionLabelHeaderProps> = ({ commandMode, ultrafixCycle, className, inspection }) => {
  const label = getSectionLabel(commandMode);
  return (
    <div className={className}>
      <div className="flex min-w-0 flex-1 items-center gap-2 py-2.5">
        <span className="text-xs font-bold uppercase tracking-widest text-slate-500">
          {label}
        </span>
        {ultrafixCycle && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-violet-50 text-violet-600">
            <RefreshCw className="h-3 w-3" />
            Ultrafix
          </span>
        )}
        {inspection && <InspectedRunContext {...inspection} />}
      </div>
    </div>
  );
};

export default SectionLabelHeader;
