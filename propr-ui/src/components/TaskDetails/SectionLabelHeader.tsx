import React from 'react';
import { GeometricScorePill } from './ResultOverview';

function getSectionLabel(commandMode: string | undefined): string {
  if (commandMode === 'review') return 'REVIEW';
  if (commandMode === 'fix') return 'FIX';
  return 'IMPLEMENTATION';
}

interface SectionLabelHeaderProps {
  commandMode: string | undefined;
  score: number | undefined;
  className?: string;
}

const SectionLabelHeader: React.FC<SectionLabelHeaderProps> = ({ commandMode, score, className }) => {
  const label = getSectionLabel(commandMode);
  return (
    <div className={className}>
      <div className="py-2.5 text-xs font-bold uppercase tracking-widest text-slate-500">
        {label}
      </div>
      {score !== undefined && (
        <GeometricScorePill score={score} />
      )}
    </div>
  );
};

export default SectionLabelHeader;
