import React from 'react';
import { Star } from 'lucide-react';

interface ScoreBadgeProps {
  score: number | null | undefined;
  dimmed?: boolean;
}

export const ScoreBadge: React.FC<ScoreBadgeProps> = ({ score, dimmed = false }) => {
  if (score === null || score === undefined) return null;

  // Determine color based on score using 4-tier grading scale
  let colorClasses: string;
  if (score >= 9) {
    // Excellent / Perfect (9-10): Teal
    colorClasses = 'bg-teal-50 text-teal-700 border-teal-200';
  } else if (score >= 7) {
    // Good / Passable (7-8): Slate/Blue-Gray
    colorClasses = 'bg-slate-100 text-slate-700 border-slate-200';
  } else if (score >= 5) {
    // Needs Review (5-6): Amber/Orange
    colorClasses = 'bg-amber-50 text-amber-700 border-amber-200';
  } else {
    // Critical Failure (0-4): Red
    colorClasses = 'bg-red-50 text-red-700 border-red-200';
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-semibold ${colorClasses} ${dimmed ? 'opacity-40' : ''}`}
      title={`Code Quality Score: ${score}/10`}
    >
      <Star size={12} fill="currentColor" />
      {score}
    </span>
  );
};
