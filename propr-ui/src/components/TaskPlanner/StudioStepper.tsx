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
 * Below `md` the breadcrumb collapses to a `Step 2/3` badge so it fits next to the scope pill
 * on a phone. Renders nothing outside a studio page (no stage in context).
 */
export const StudioPhaseSwitcher: React.FC<StudioPhaseSwitcherProps> = ({ counts, className = '' }) => {
  const currentStage = useContext(StudioStageContext);
  if (!currentStage) return null;
  const current = STEPS.find((step) => step.id === currentStage)!;

  return (
    <nav aria-label="Plan phase" className={`flex-shrink-0 ${className}`}>
      <span
        data-testid="phase-step-badge"
        aria-label={`Step ${current.number} of ${STEPS.length}: ${current.shortLabel}`}
        className="inline-flex items-center whitespace-nowrap rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium tabular-nums text-slate-700 md:hidden"
      >
        Step {current.number}/{STEPS.length}
      </span>
      <ol className="hidden md:flex items-center gap-0.5 rounded-md border border-slate-200 bg-white p-0.5 text-xs">
        {STEPS.map((step, index) => {
          const state = getStepState(step.id, currentStage);
          const count = counts?.[step.id];
          return (
            <li key={step.id} className="flex items-center gap-0.5">
              {index > 0 && <ChevronRight size={12} className="text-slate-300" aria-hidden="true" />}
              <span
                aria-current={state === 'active' ? 'step' : undefined}
                className={`flex items-center gap-1 whitespace-nowrap rounded px-2 py-1 ${
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
                <span>{step.shortLabel}</span>
                {count !== undefined && <span className="tabular-nums opacity-70">({count})</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

