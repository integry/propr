import React from 'react';
import { Check } from 'lucide-react';

export type StudioStage = 'draft' | 'review' | 'execute';

interface StudioStepperProps {
  currentStage: StudioStage;
}

interface Step {
  id: StudioStage;
  number: number;
  label: string;
  shortLabel: string;
}

const STEPS: Step[] = [
  { id: 'draft', number: 1, label: 'Define & Context', shortLabel: 'Define' },
  { id: 'review', number: 2, label: 'Review Plan', shortLabel: 'Review' },
  { id: 'execute', number: 3, label: 'Execution', shortLabel: 'Execute' },
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

const StudioStepper: React.FC<StudioStepperProps> = ({ currentStage }) => {
  return (
    <nav aria-label="Progress" className="w-full">
      <ol className="flex items-center justify-center">
        {STEPS.map((step, index) => {
          const state = getStepState(step.id, currentStage);
          const isLast = index === STEPS.length - 1;

          return (
            <li
              key={step.id}
              className={`flex items-center ${!isLast ? 'flex-1' : ''}`}
            >
              <div className="flex items-center">
                {/* Step circle */}
                <div
                  className={`
                    flex h-6 w-6 sm:h-8 sm:w-8 items-center justify-center rounded-full text-xs sm:text-sm font-medium
                    transition-all duration-200 ease-in-out
                    ${
                      state === 'completed'
                        ? 'bg-green-100 text-green-600 border-2 border-green-300'
                        : state === 'active'
                        ? 'bg-primary-600 text-white'
                        : 'bg-white text-gray-500 border-2 border-gray-300'
                    }
                  `}
                >
                  {state === 'completed' ? (
                    <Check className="h-4 w-4 stroke-[2.5]" />
                  ) : (
                    step.number
                  )}
                </div>

                {/* Step label - short on mobile, full on desktop */}
                <span
                  className={`
                    ml-2 text-sm whitespace-nowrap transition-all duration-200 ease-in-out hidden sm:inline
                    ${
                      state === 'completed'
                        ? 'font-medium text-green-600'
                        : state === 'active'
                        ? 'font-bold text-primary-600'
                        : 'font-medium text-gray-500'
                    }
                  `}
                >
                  {step.label}
                </span>
                <span
                  className={`
                    ml-2 text-xs whitespace-nowrap transition-all duration-200 ease-in-out sm:hidden
                    ${
                      state === 'completed'
                        ? 'font-medium text-green-600'
                        : state === 'active'
                        ? 'font-bold text-primary-600'
                        : 'font-medium text-gray-500'
                    }
                  `}
                >
                  {step.shortLabel}
                </span>
              </div>

              {/* Connector line */}
              {!isLast && (
                <div
                  className={`
                    mx-2 sm:mx-4 h-0.5 flex-1 min-w-[20px] sm:min-w-[40px] transition-all duration-200 ease-in-out
                    ${
                      state === 'completed'
                        ? 'bg-primary-600'
                        : 'bg-gray-300 border-t-2 border-dashed border-gray-300'
                    }
                  `}
                  style={state !== 'completed' ? { background: 'transparent' } : {}}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

export default StudioStepper;
