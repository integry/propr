// ScoreBadge component - displays code quality score with visual hierarchy
import React from 'react';
import { Triangle, Square, Diamond, Circle } from 'lucide-react';

interface ScoreBadgeProps {
  score: number | null | undefined;
  dimmed?: boolean;
}

export const ScoreBadge: React.FC<ScoreBadgeProps> = ({ score, dimmed = false }) => {
  if (score === null || score === undefined) return null;

  // Determine color and shape based on score using 4-tier grading scale
  let colorClasses: string;
  let ShapeIcon: typeof Triangle;

  if (score >= 9) {
    // Perfect (9-10): Teal with Circle (smooth, no friction)
    colorClasses = 'bg-teal-50 text-teal-600';
    ShapeIcon = Circle;
  } else if (score >= 7) {
    // Good (7-8): Slate with Diamond (edges, solid)
    colorClasses = 'bg-slate-100 text-slate-600';
    ShapeIcon = Diamond;
  } else if (score >= 5) {
    // Needs Review (5-6): Amber with Square (edges, solid)
    colorClasses = 'bg-amber-50 text-amber-600';
    ShapeIcon = Square;
  } else {
    // Critical (0-4): Red with Triangle (pointy, hurts to touch)
    colorClasses = 'bg-red-50 text-red-600';
    ShapeIcon = Triangle;
  }

  return (
    <span
      className={`ml-auto inline-flex justify-start items-center gap-1 w-12 min-w-12 max-w-12 pl-2 py-0.5 rounded-full ${colorClasses} ${dimmed ? 'opacity-40' : ''}`}
      title={`Code Quality Score: ${score}/10`}
    >
      <ShapeIcon size={8} fill="currentColor" />
      <span className="font-mono text-sm font-bold">{score}</span>
    </span>
  );
};
