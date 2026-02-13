import React from 'react';

interface ScoreBadgeProps {
  score: number | null | undefined;
  dimmed?: boolean;
}

export const ScoreBadge: React.FC<ScoreBadgeProps> = ({ score, dimmed = false }) => {
  if (score === null || score === undefined) return null;

  // Determine color based on score
  let colorClasses: string;
  if (score >= 8) {
    colorClasses = 'bg-green-500';
  } else if (score <= 4) {
    colorClasses = 'bg-red-500';
  } else {
    colorClasses = 'bg-yellow-500';
  }

  return (
    <span
      className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-xs font-bold ${colorClasses} ${dimmed ? 'opacity-40' : ''}`}
      title={`Implementation Critique Score: ${score}/10`}
    >
      {score}
    </span>
  );
};
