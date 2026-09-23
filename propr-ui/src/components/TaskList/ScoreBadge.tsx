// ScoreBadge component - displays code quality score with visual hierarchy
import React from 'react';
import { Triangle, Square, Diamond, Circle } from 'lucide-react';

interface ScoreBadgeProps {
  score: number | null | undefined;
  dimmed?: boolean;
  className?: string;
  /**
   * Draw the score inside square brackets: `[ ● 9 ]`.
   *
   * Reserved for fixed-width right rails (the dashboard's outcome feed), where
   * the brackets give every score the same visible start and end and stop the
   * rail from vibrating as 7, 8 and 9 trade places. The task list asked for the
   * bare form, so brackets are opt-in rather than the default.
   */
  bracketed?: boolean;
}

export const ScoreBadge: React.FC<ScoreBadgeProps> = ({ score, dimmed = false, className = '', bracketed = false }) => {
  if (score === null || score === undefined) return null;

  // Determine color and shape based on score using 4-tier grading scale
  let colorClasses: string;
  let ShapeIcon: typeof Triangle;

  if (score >= 9) {
    // Perfect (9-10): Teal with Circle (smooth, no friction)
    colorClasses = 'text-primary-600';
    ShapeIcon = Circle;
  } else if (score >= 7) {
    // Good (7-8): Slate with Diamond (edges, solid)
    colorClasses = 'text-slate-600';
    ShapeIcon = Diamond;
  } else if (score >= 5) {
    // Needs Review (5-6): Amber with Square (edges, solid)
    colorClasses = 'text-amber-600';
    ShapeIcon = Square;
  } else {
    // Critical (0-4): Red with Triangle (pointy, hurts to touch)
    colorClasses = 'text-red-600';
    ShapeIcon = Triangle;
  }

  return (
    <span
      className={`inline-flex justify-center items-center gap-0.5 w-12 min-w-12 max-w-12 py-0.5 font-mono text-sm font-bold tabular-nums ${colorClasses} ${dimmed ? 'opacity-40' : ''} ${className}`}
      title={`Code Quality Score: ${score}/10`}
    >
      {bracketed && <span aria-hidden="true" className="text-slate-400">[</span>}
      <ShapeIcon size={8} className="shrink-0" fill="currentColor" aria-hidden="true" />
      <span>{score}</span>
      {bracketed && <span aria-hidden="true" className="text-slate-400">]</span>}
    </span>
  );
};
