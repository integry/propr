import React from 'react';
import { Check } from 'lucide-react';

export type OnboardingStepStatus = 'active' | 'completed' | 'pending';

export interface OnboardingStepProps {
  /** The step number to display (shown as number for active/pending, checkmark for completed) */
  stepNumber: number;
  /** The title of the step */
  title: string;
  /** A description of what this step involves */
  description: string;
  /** The visual state of the step */
  status: OnboardingStepStatus;
  /** The text to display on the action button */
  actionLabel?: string;
  /** Callback when the action button is clicked */
  onAction?: () => void;
}

/**
 * OnboardingStep component displays a single step in the onboarding journey.
 *
 * Supports three visual states:
 * - `active`: Highlighted with indigo styling, CTA button is prominent
 * - `completed`: Shows checkmark instead of number, green styling, CTA hidden
 * - `pending`: Muted gray styling, CTA button is subdued
 */
export const OnboardingStep: React.FC<OnboardingStepProps> = ({
  stepNumber,
  title,
  description,
  status,
  actionLabel = 'Get Started',
  onAction,
}) => {
  const isCompleted = status === 'completed';
  const isActive = status === 'active';
  const isPending = status === 'pending';

  return (
    <div
      className={`
        flex items-start gap-4 p-4 rounded-lg border transition-all duration-200
        ${isActive ? 'border-indigo-200 bg-indigo-50/50' : ''}
        ${isCompleted ? 'border-slate-200 bg-white' : ''}
        ${isPending ? 'border-slate-200 bg-slate-50/50' : ''}
      `}
    >
      {/* Step Number / Checkmark Circle */}
      <div
        className={`
          flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium
          transition-all duration-200
          ${isCompleted ? 'bg-green-100 text-green-600 border-2 border-green-300' : ''}
          ${isActive ? 'bg-indigo-600 text-white' : ''}
          ${isPending ? 'bg-white text-slate-500 border-2 border-slate-300' : ''}
        `}
      >
        {isCompleted ? (
          <Check className="h-4 w-4 stroke-[2.5]" />
        ) : (
          stepNumber
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Title */}
        <h4
          className={`
            text-sm font-semibold transition-colors duration-200
            ${isCompleted ? 'text-slate-500' : ''}
            ${isActive ? 'text-indigo-900' : ''}
            ${isPending ? 'text-slate-600' : ''}
          `}
        >
          {title}
        </h4>

        {/* Description */}
        <p
          className={`
            mt-1 text-sm leading-relaxed
            ${isCompleted ? 'text-slate-400' : ''}
            ${isActive ? 'text-indigo-700' : ''}
            ${isPending ? 'text-slate-500' : ''}
          `}
        >
          {description}
        </p>

        {/* Action Button - Hidden when completed */}
        {!isCompleted && onAction && (
          <button
            onClick={onAction}
            className={`
              mt-3 inline-flex items-center px-4 py-2 text-sm font-medium rounded-md
              transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2
              ${isActive
                ? 'bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-500'
                : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50 hover:border-slate-400 focus:ring-slate-400'
              }
            `}
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
};

export default OnboardingStep;
