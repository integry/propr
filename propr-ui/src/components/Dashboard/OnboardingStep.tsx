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
 * Follows the Studio Aesthetic guidelines - uses divider-based layout instead of cards.
 * Supports three visual states:
 * - `active`: Teal styling (Brand color), prominent CTA button
 * - `completed`: Gray styling (Success is Quiet), checkmark shown, CTA hidden
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
    <div className="flex items-start gap-3 py-3 transition-all duration-200">
      {/* Step Number / Checkmark - inline indicator */}
      <div
        className={`
          flex h-6 w-6 flex-shrink-0 items-center justify-center text-xs font-medium
          transition-all duration-200
          ${isCompleted ? 'text-slate-400' : ''}
          ${isActive ? 'text-teal-600' : ''}
          ${isPending ? 'text-slate-400' : ''}
        `}
      >
        {isCompleted ? (
          <Check className="h-4 w-4 stroke-[2.5]" />
        ) : (
          <span className="font-mono">{stepNumber}.</span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Title and Description inline */}
        <div className="flex items-baseline gap-2 flex-wrap">
          <span
            className={`
              text-sm font-medium transition-colors duration-200
              ${isCompleted ? 'text-slate-400' : ''}
              ${isActive ? 'text-slate-900' : ''}
              ${isPending ? 'text-slate-500' : ''}
            `}
          >
            {title}
          </span>
          <span
            className={`
              text-sm transition-colors duration-200
              ${isCompleted ? 'text-slate-400' : ''}
              ${isActive ? 'text-slate-600' : ''}
              ${isPending ? 'text-slate-400' : ''}
            `}
          >
            — {description}
          </span>
        </div>

        {/* Action Button - Hidden when completed, inline link style for pending */}
        {!isCompleted && onAction && (
          <button
            onClick={onAction}
            className={`
              mt-2 inline-flex items-center text-sm font-medium
              transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2
              ${isActive
                ? 'px-3 py-1.5 bg-teal-600 text-white rounded-md hover:bg-teal-700 focus:ring-teal-500'
                : 'text-slate-500 hover:text-slate-700 underline-offset-2 hover:underline focus:ring-slate-400'
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
