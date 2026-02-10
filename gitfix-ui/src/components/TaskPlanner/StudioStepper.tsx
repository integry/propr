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
}

const STEPS: Step[] = [
  { id: 'draft', number: 1, label: 'Define & Context' },
  { id: 'review', number: 2, label: 'Review Plan' },
  { id: 'execute', number: 3, label: 'Execution' },
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
                    flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors
                    ${
                      state === 'completed'
                        ? 'text-white'
                        : state === 'active'
                        ? 'border-2 bg-white'
                        : 'border-2 border-gray-300 bg-white text-gray-400'
                    }
                  `}
                  style={
                    state === 'completed'
                      ? { backgroundColor: 'rgb(29, 138, 138)' }
                      : state === 'active'
                      ? { borderColor: 'rgb(29, 138, 138)', color: 'rgb(29, 138, 138)' }
                      : undefined
                  }
                >
                  {state === 'completed' ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    step.number
                  )}
                </div>

                {/* Step label */}
                <span
                  className={`
                    ml-2 text-sm font-medium whitespace-nowrap
                    ${state === 'pending' ? 'text-gray-400' : ''}
                  `}
                  style={state !== 'pending' ? { color: 'rgb(29, 138, 138)' } : undefined}
                >
                  {step.label}
                </span>
              </div>

              {/* Connector line */}
              {!isLast && (
                <div
                  className={`
                    mx-4 h-0.5 flex-1 min-w-[40px]
                    ${
                      getStepState(STEPS[index + 1].id, currentStage) !== 'pending'
                        ? ''
                        : 'bg-gray-300'
                    }
                  `}
                  style={getStepState(STEPS[index + 1].id, currentStage) !== 'pending' ? { backgroundColor: 'rgb(29, 138, 138)' } : undefined}
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
