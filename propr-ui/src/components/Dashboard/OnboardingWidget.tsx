import React from 'react';
import { useNavigate } from 'react-router-dom';
import { OnboardingStep, OnboardingStepStatus } from './OnboardingStep';

export interface OnboardingWidgetProps {
  /** Whether the user has configured at least one AI agent */
  hasAgents: boolean;
  /** Whether the user has added at least one repository */
  hasRepos: boolean;
}

/**
 * OnboardingWidget displays the onboarding steps for new users on the dashboard.
 *
 * Follows the Studio Aesthetic guidelines - uses divider-based layout instead of cards.
 * It shows two steps:
 * 1. Configure an AI Agent
 * 2. Add a Repository
 *
 * The repo step only becomes 'active' after the agent step is 'completed'.
 */
export const OnboardingWidget: React.FC<OnboardingWidgetProps> = ({
  hasAgents,
  hasRepos,
}) => {
  const navigate = useNavigate();

  const getAgentStepStatus = (): OnboardingStepStatus => {
    if (hasAgents) return 'completed';
    return 'active';
  };

  const getRepoStepStatus = (): OnboardingStepStatus => {
    if (hasRepos) return 'completed';
    if (hasAgents) return 'active';
    return 'pending';
  };

  const handleConfigureAgent = () => {
    navigate('/ai-agents');
  };

  const handleAddRepository = () => {
    navigate('/repositories');
  };

  return (
    <div className="border-b border-slate-200 pb-4">
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">
        Getting Started
      </h3>
      <div className="divide-y divide-slate-100">
        <OnboardingStep
          stepNumber={1}
          title="Configure an AI Agent"
          description="Set up your first AI coding agent"
          status={getAgentStepStatus()}
          actionLabel="Configure Agent"
          onAction={handleConfigureAgent}
        />
        <OnboardingStep
          stepNumber={2}
          title="Add a Repository"
          description="Connect a GitHub repository"
          status={getRepoStepStatus()}
          actionLabel="Add Repository"
          onAction={handleAddRepository}
        />
      </div>
    </div>
  );
};

export default OnboardingWidget;
