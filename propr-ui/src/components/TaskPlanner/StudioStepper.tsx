import React, { useContext } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { StudioStageContext, type StudioStage } from './studioStageContext';

export type { StudioStage };

interface Step {
  id: StudioStage;
  number: number;
  shortLabel: string;
}

const STEPS: Step[] = [
  { id: 'draft', number: 1, shortLabel: 'Define' },
  { id: 'review', number: 2, shortLabel: 'Review' },
  { id: 'execute', number: 3, shortLabel: 'Execute' },
];

const getStepState = (
  stepId: StudioStage,
  currentStage: StudioStage
): 'completed' | 'active' | 'pending' => {
  const stepIndex = STEPS.findIndex((s) => s.id === stepId);
  const currentIndex = STEPS.findIndex((s) => s.id === currentStage);

  if (stepIndex < currentIndex) return 'completed';
  if (stepIndex === currentIndex) return 'active';
  return 'pending';
};

interface StudioPhaseSwitcherProps {
  /** Shown next to a phase label, e.g. the number of tasks under review. */
  counts?: Partial<Record<StudioStage, number>>;
  className?: string;
}

/**
 * Compact phase indicator for every studio title row: `✓ Define › 2 Review (17) › 3 Execute`.
 * Below `md` only the current phase keeps its visible label (`✓ › ✓ › 3 Execute`) so the pill
 * fits a phone title row; the other labels stay available to screen readers.
 * Renders nothing outside a studio page (no stage in context).
 */
export const StudioPhaseSwitcher: React.FC<StudioPhaseSwitcherProps> = ({ counts, className = '' }) => {
  const currentStage = useContext(StudioStageContext);
  if (!currentStage) return null;

  return (
    <nav aria-label="Plan phase" className={`flex-shrink-0 ${className}`}>
      <ol className="flex items-center gap-0.5 rounded-md border border-slate-200 bg-white p-0.5 text-xs">
        {STEPS.map((step, index) => {
          const state = getStepState(step.id, currentStage);
          const count = counts?.[step.id];
          return (
            <li key={step.id} className="flex items-center gap-0.5">
              {index > 0 && <ChevronRight size={12} className="text-slate-300" aria-hidden="true" />}
              <span
                aria-current={state === 'active' ? 'step' : undefined}
                className={`flex items-center gap-1 whitespace-nowrap rounded px-1.5 md:px-2 py-1 ${
                  state === 'active'
                    ? 'bg-teal-50 font-medium text-teal-800'
                    : state === 'completed'
                    ? 'text-slate-600'
                    : 'text-slate-400'
                }`}
              >
                {state === 'completed' ? (
                  <Check size={12} className="text-teal-600" aria-label="Done" />
                ) : (
                  <span className="font-mono tabular-nums">{step.number}</span>
                )}
                <span className={state === 'active' ? undefined : 'sr-only md:not-sr-only'}>{step.shortLabel}</span>
                {count !== undefined && <span className="tabular-nums opacity-70">({count})</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

