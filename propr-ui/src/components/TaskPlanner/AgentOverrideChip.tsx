import React from 'react';
import { createPortal } from 'react-dom';
import { PlanIssue, AgentModelPair } from '../../api/planIssuesApi';
import type { InstanceCatalogAgent } from '@propr/shared';
import { ProviderLogo } from '../ui/ProviderLogo';
import AgentModelSelector from './AgentModelSelector';
import { getModelName, getShortModelName } from './planIssueRowUtils';
import { useAnchoredPopover } from './useAnchoredPopover';
import { isOverriddenFromDefault, type PlanIssueDefaultSelection } from './planIssueDefaultSelection';

const getAgentChipLabel = (issue: PlanIssue, isMultiMode: boolean, selectedModels: AgentModelPair[]): string => {
  if (isMultiMode) return selectedModels.length > 0 ? `${selectedModels.length} models` : 'Choose models';
  if (!issue.agent_alias) return 'Choose agent';
  return getShortModelName(issue.model_name) || issue.agent_alias;
};

export interface AgentOverrideChipProps {
  agents: InstanceCatalogAgent[];
  issue: PlanIssue;
  disabled: boolean;
  isMultiMode: boolean;
  selectedModels: AgentModelPair[];
  onAgentChange: (issueNumber: number, agentAlias: string | null) => void | Promise<void>;
  onModelChange: (issueNumber: number, modelName: string | null) => void | Promise<void>;
  /** The plan's default agent/model (the toolbar selection). Enables "Reset to default" when the issue differs. */
  defaultSelection?: PlanIssueDefaultSelection | null;
  handleMultiToggle: (multi: boolean) => void;
  handleMultiModelChange: (models: AgentModelPair[]) => void;
  handleImplementClick: () => void;
}

/**
 * The issue's agent as a compact chip. Most issues keep the toolbar default, so
 * the agent and model selects only appear in a popover when the chip is clicked.
 */
export const AgentOverrideChip: React.FC<AgentOverrideChipProps> = ({
  agents, issue, disabled, isMultiMode, selectedModels, defaultSelection,
  onAgentChange, onModelChange, handleMultiToggle, handleMultiModelChange, handleImplementClick,
}) => {
  // The popover is portalled with fixed, viewport-aware coordinates so neither the row's overflow
  // clipping nor the viewport edge can cut it off.
  const { open, position, toggle, close, containerRef, popoverRef } = useAnchoredPopover({ focusOnOpen: true });
  const issueNumber = issue.issue_number;
  const label = getAgentChipLabel(issue, isMultiMode, selectedModels);
  const canReset = !isMultiMode && isOverriddenFromDefault(issue, defaultSelection);
  const handleReset = async () => {
    if (!defaultSelection?.agentAlias) return;
    close();
    // Changing the agent also picks that agent's default model, so the plan's model is applied after it.
    if (issue.agent_alias !== defaultSelection.agentAlias) await onAgentChange(issueNumber, defaultSelection.agentAlias);
    if (defaultSelection.modelName) await onModelChange(issueNumber, defaultSelection.modelName);
  };
  const agentTitle = issue.agent_alias ? `${issue.agent_alias} / ${getModelName(issue.model_name) || 'default model'}` : 'No agent selected';

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${agentTitle} — click to override for #${issueNumber}`}
        className={`inline-flex max-w-[160px] items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          issue.agent_alias || (isMultiMode && selectedModels.length > 0)
            ? 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
        }`}
        data-testid="agent-override-chip"
      >
        {!isMultiMode && issue.agent_alias && <ProviderLogo provider={issue.agent_alias} className="w-3 h-3 flex-shrink-0" />}
        <span className="truncate">{label}</span>
      </button>
      {position && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`Agent override for #${issueNumber}`}
          tabIndex={-1}
          style={position}
          className="fixed z-50 focus:outline-none w-max max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-slate-200 bg-white p-3 shadow-lg"
        >
          <div className="mb-2 flex items-baseline justify-between gap-4">
            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Agent for #{issueNumber}</span>
            {canReset && (
              <button
                type="button"
                onClick={() => { void handleReset(); }}
                disabled={disabled}
                title={`Use the plan default (${defaultSelection?.agentAlias}${defaultSelection?.modelName ? ` / ${getModelName(defaultSelection.modelName)}` : ''})`}
                className="text-xs font-medium text-teal-700 hover:text-teal-900 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
              >
                Reset to default
              </button>
            )}
          </div>
          <AgentModelSelector
            agents={agents}
            selectedAgent={issue.agent_alias}
            selectedModel={issue.model_name}
            onAgentChange={(agent) => onAgentChange(issueNumber, agent)}
            onModelChange={(model) => onModelChange(issueNumber, model)}
            disabled={disabled}
            compact
            isMulti={isMultiMode}
            onMultiToggle={handleMultiToggle}
            selectedModels={selectedModels}
            onMultiModelChange={handleMultiModelChange}
            onMultiConfirm={() => { close(); handleImplementClick(); }}
          />
        </div>,
        document.body
      )}
    </div>
  );
};
