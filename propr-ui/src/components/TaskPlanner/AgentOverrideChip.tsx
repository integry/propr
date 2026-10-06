import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PlanIssue, AgentModelPair } from '../../api/planIssuesApi';
import type { InstanceCatalogAgent } from '@propr/shared';
import { ProviderLogo } from '../ui/ProviderLogo';
import AgentModelSelector from './AgentModelSelector';
import { getModelName, getShortModelName } from './planIssueRowUtils';

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
  onAgentChange: (issueNumber: number, agentAlias: string | null) => void;
  onModelChange: (issueNumber: number, modelName: string | null) => void;
  handleMultiToggle: (multi: boolean) => void;
  handleMultiModelChange: (models: AgentModelPair[]) => void;
  handleImplementClick: () => void;
}

/**
 * The issue's agent as a compact chip. Most issues keep the toolbar default, so
 * the agent and model selects only appear in a popover when the chip is clicked.
 */
export const AgentOverrideChip: React.FC<AgentOverrideChipProps> = ({
  agents, issue, disabled, isMultiMode, selectedModels,
  onAgentChange, onModelChange, handleMultiToggle, handleMultiModelChange, handleImplementClick,
}) => {
  // The popover is portalled with fixed coordinates so the row's overflow clipping cannot cut it off.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const open = anchor !== null;
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const close = () => setAnchor(null);
  const toggle = () => {
    if (open) { close(); return; }
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  };
  const issueNumber = issue.issue_number;
  const label = getAgentChipLabel(issue, isMultiMode, selectedModels);
  const agentTitle = issue.agent_alias ? `${issue.agent_alias} / ${getModelName(issue.model_name) || 'default model'}` : 'No agent selected';

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) close();
    };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    const handleScroll = (event: Event) => {
      if (!popoverRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('resize', close);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', close);
    };
  }, [open]);

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
      {anchor && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`Agent override for #${issueNumber}`}
          style={{ top: anchor.top, right: anchor.right }}
          className="fixed z-50 w-max max-w-[calc(100vw-2rem)] rounded-md border border-slate-200 bg-white p-3 shadow-lg"
        >
          <div className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Agent for #{issueNumber}</div>
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
