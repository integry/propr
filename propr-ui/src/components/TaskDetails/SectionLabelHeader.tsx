import React from 'react';
import { GeometricScorePill } from './ResultOverview';
import { RefreshCw } from 'lucide-react';

function getSectionLabel(commandMode: string | undefined): string {
  if (commandMode === 'review') return 'REVIEW';
  if (commandMode === 'fix') return 'FIX';
  return 'IMPLEMENTATION';
}

interface SectionLabelHeaderProps {
  commandMode: string | undefined;
  score: number | undefined;
  ultrafixCycle?: boolean;
  className?: string;
}

const SectionLabelHeader: React.FC<SectionLabelHeaderProps> = ({ commandMode, score, ultrafixCycle, className }) => {
  const label = getSectionLabel(commandMode);
  return (
    <div className={className}>
      <div className="flex items-center gap-2 py-2.5">
        <span className="text-xs font-bold uppercase tracking-widest text-slate-500">
          {label}
        </span>
        {ultrafixCycle && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-violet-50 text-violet-600">
            <RefreshCw className="h-3 w-3" />
            Ultrafix
          </span>
        )}
      </div>
      {score !== undefined && (
        <GeometricScorePill score={score} />
      )}
    </div>
  );
};

export default SectionLabelHeader;
