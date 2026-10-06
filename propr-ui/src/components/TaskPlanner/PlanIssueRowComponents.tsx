import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ExternalLink, GitPullRequest, MessageSquare, Play, Loader2, Eye, ChevronDown, StickyNote } from 'lucide-react';
import { PlanIssue, PlanIssueStatus, STATUS_CONFIG, AgentModelPair } from '../../api/planIssuesApi';
import { AgentOverrideChip } from './AgentOverrideChip';
import { getAttachmentUrl } from '../../api/proprApi';
import type { InstanceCatalogAgent } from '@propr/shared';
import { PlanTask } from '../../api/plannerApi';
import { ProviderLogo } from '../ui/ProviderLogo';
import MarkdownRenderer from '../TaskDetails/MarkdownRenderer';
import { getModelName, getShortModelName, getImplementButtonClassName, getImplementButtonTitle } from './planIssueRowUtils';
import { AuthenticatedAttachmentImage } from './AuthenticatedAttachmentImage';

interface UltrafixSettingsControlsProps { enabled: boolean; goal: number | null | undefined; maxCycles: number | null | undefined; onGoalChange: (value: number | null) => void; onMaxCyclesChange: (value: number | null) => void; goalPlaceholder: string; maxPlaceholder: string; inputClassName: string; goalInputWidthClassName: string; maxInputWidthClassName: string; containerClassName?: string; errorClassName?: string; goalLabel?: string; maxLabel?: string; }

// Each goal reads as the score pill it targets: same shape tiers as ScoreBadge, out of 10.
const ULTRAFIX_GOAL_OPTIONS: { value: number; label: string }[] = [
  { value: 10, label: '● 10/10 (Perfect)' },
  { value: 9, label: '● 9/10 (Strict)' },
  { value: 8, label: '◆ 8/10 (Standard)' },
  { value: 7, label: '◆ 7/10 (Lenient)' },
  { value: 6, label: '■ 6/10 (Needs review)' },
  { value: 5, label: '■ 5/10 (Needs review)' },
];
const isUltrafixGoalOption = (goal: number | null | undefined) => ULTRAFIX_GOAL_OPTIONS.some((option) => option.value === goal);

function parseUltrafixIntegerInput(
  rawValue: string,
  options: { minimum: number; maximum?: number; label: string }
): { value: number | null; error: string | null } {
  const trimmedValue = rawValue.trim();
  if (trimmedValue === '') return { value: null, error: null };

  const nextValue = Number(trimmedValue);
  if (!Number.isInteger(nextValue)) return { value: null, error: `${options.label} must be a whole number` };
  if (nextValue < options.minimum) return { value: null, error: `${options.label} must be at least ${options.minimum}` };
  if (options.maximum !== undefined && nextValue > options.maximum) return { value: null, error: `${options.label} must be at most ${options.maximum}` };

  return { value: nextValue, error: null };
}

export const UltrafixSettingsControls: React.FC<UltrafixSettingsControlsProps> = ({
  enabled,
  goal,
  maxCycles,
  onGoalChange,
  onMaxCyclesChange,
  goalPlaceholder,
  maxPlaceholder,
  inputClassName,
  goalInputWidthClassName,
  maxInputWidthClassName,
  containerClassName = 'flex flex-col gap-1',
  errorClassName = 'text-[11px] text-amber-700',
  goalLabel = 'Min Review Score',
  maxLabel = 'Max Loops',
}) => {
  const [maxCyclesInput, setMaxCyclesInput] = useState(maxCycles?.toString() ?? '');
  const [maxCyclesError, setMaxCyclesError] = useState<string | null>(null);
  useEffect(() => { setMaxCyclesInput(maxCycles?.toString() ?? ''); setMaxCyclesError(null); }, [maxCycles]);
  useEffect(() => { if (!enabled) setMaxCyclesError(null); }, [enabled]);

  const commitMaxCycles = () => {
    const result = parseUltrafixIntegerInput(maxCyclesInput, { minimum: 1, label: maxLabel });
    if (result.error) { setMaxCyclesError(result.error); return; }
    setMaxCyclesError(null); if (result.value !== maxCycles) onMaxCyclesChange(result.value);
  };

  return (
    <div className={containerClassName}>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500 whitespace-nowrap">{goalLabel}</span>
          <select
            value={isUltrafixGoalOption(goal) ? goal?.toString() : ''}
            disabled={!enabled}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isInteger(value)) onGoalChange(value);
            }}
            className={`${goalInputWidthClassName} ${inputClassName}`}
          >
            {!isUltrafixGoalOption(goal) && <option value="" disabled>{goalPlaceholder}</option>}
            {ULTRAFIX_GOAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500 whitespace-nowrap">{maxLabel}</span>
          <input
            type="number"
            min={1}
            value={maxCyclesInput}
            disabled={!enabled}
            onChange={(e) => {
              setMaxCyclesInput(e.target.value);
              if (maxCyclesError) setMaxCyclesError(null);
            }}
            onBlur={commitMaxCycles}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder={maxPlaceholder}
            className={`${maxInputWidthClassName} ${inputClassName}`}
          />
        </label>
      </div>
      {maxCyclesError && <p className={errorClassName}>{maxCyclesError}</p>}
    </div>
  );
};

export const StatusBadge: React.FC<{ status: PlanIssueStatus }> = ({ status }) => {
  const config = STATUS_CONFIG[status];

  return (
    <span className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 text-xs font-medium rounded border ${config.color} ${config.bgColor} ${config.borderColor}`}>
      <span className="relative flex h-1.5 w-1.5">
        {config.isActive && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.dotColor} opacity-60`} />}
        <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${config.dotColor}`} />
      </span>
      {config.label}
    </span>
  );
};

export interface ImplementButtonProps { implementing: boolean; disabled?: boolean; hasAgent: boolean; isFirstPending: boolean; pressed?: boolean; label?: string; onClick: () => void; }
export const ImplementButton: React.FC<ImplementButtonProps> = ({ implementing, disabled = false, hasAgent, isFirstPending, pressed = false, label = 'Implement', onClick }) => (
  <button
    onClick={onClick}
    disabled={implementing || disabled || !hasAgent}
    className={`
      flex items-center gap-1 sm:gap-1.5
      px-2 sm:px-3 py-1.5
      text-xs sm:text-sm font-medium
      rounded-md
      transition-colors
      ${pressed && !implementing && hasAgent
        ? isFirstPending
          ? 'bg-primary-700 text-white shadow-inner'
          : 'bg-slate-100 border border-slate-400 text-slate-800 shadow-inner'
        : getImplementButtonClassName(implementing, hasAgent, isFirstPending)}
    `}
    title={getImplementButtonTitle(hasAgent, isFirstPending)}
  >
    {implementing ? (
      <>
        <Loader2 size={14} className="animate-spin" />
        <span>Starting...</span>
      </>
    ) : (
      <>
        <Play size={14} className={!isFirstPending && hasAgent ? 'opacity-60' : ''} />
        <span>{label}</span>
      </>
    )}
  </button>
);

export interface AgentModelInfoProps { agentAlias: string; modelName: string | null; }
export const AgentModelInfo: React.FC<AgentModelInfoProps> = ({ agentAlias, modelName }) => (
  // Same chip geometry as AgentOverrideChip so the agent column keeps its shape once a run starts.
  <span
    className="inline-flex max-w-[160px] items-center gap-1.5 rounded bg-slate-100 px-2 py-1 text-xs text-slate-600"
    title={`${agentAlias} / ${getModelName(modelName) || 'default model'}`}
    data-testid="agent-chip"
  >
    <ProviderLogo provider={agentAlias} className="w-3 h-3 flex-shrink-0" />
    <span className="truncate">{getShortModelName(modelName) || agentAlias}</span>
  </span>
);

export interface PrLinkProps { prUrl: string; prNumber: number; }
export const PrLink: React.FC<PrLinkProps> = ({ prUrl, prNumber }) => (<a href={prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-slate-600 hover:text-slate-900 hover:underline transition-colors" onClick={(e) => e.stopPropagation()}><GitPullRequest size={12} /><span>PR #{prNumber}</span><ExternalLink size={10} className="opacity-50" /></a>);

export interface FollowupCountProps { count: number; }
export const FollowupCount: React.FC<FollowupCountProps> = ({ count }) => (
  <span className="flex items-center gap-1 text-gray-500">
    <MessageSquare size={12} />
    {count} follow-up{count !== 1 ? 's' : ''}
  </span>
);

export interface ViewProgressLinkProps { taskId: string; }
export const ViewProgressLink: React.FC<ViewProgressLinkProps> = ({ taskId }) => (<Link to={`/tasks/${encodeURIComponent(taskId)}`} className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-800 hover:underline transition-colors" onClick={(e) => e.stopPropagation()}><Eye size={12} />View Progress</Link>);

export interface RowActionsProps {
  isPending: boolean;
  hasExpandableContent: boolean;
  isExpanded: boolean;
  implementing: boolean;
  isMultiMode: boolean;
  selectedModels: AgentModelPair[];
  hasAgent: boolean;
  isFirstPending: boolean;
  agents: InstanceCatalogAgent[];
  issue: PlanIssue;
  onAgentChange: (issueNumber: number, agentAlias: string | null) => void;
  onModelChange: (issueNumber: number, modelName: string | null) => void;
  disableImplementation?: boolean;
  implementButtonPressed?: boolean;
  showImplementButton?: boolean;
  implementButtonLabel?: string;
  handleMultiToggle: (multi: boolean) => void;
  handleMultiModelChange: (models: AgentModelPair[]) => void;
  handleImplementClick: () => void;
  handleToggleExpand: (e: React.MouseEvent) => void;
}

export const RowActions: React.FC<RowActionsProps> = ({
  isPending,
  hasExpandableContent,
  isExpanded,
  implementing,
  isMultiMode,
  selectedModels,
  hasAgent,
  isFirstPending,
  agents,
  issue,
  onAgentChange,
  onModelChange,
  disableImplementation = false,
  implementButtonPressed = false,
  showImplementButton = true,
  implementButtonLabel = 'Implement',
  handleMultiToggle,
  handleMultiModelChange,
  handleImplementClick,
  handleToggleExpand
}) => {
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2 lg:w-auto lg:flex-none lg:flex-nowrap lg:justify-end lg:gap-3">
      {isPending && (
        <AgentOverrideChip
          agents={agents}
          issue={issue}
          disabled={implementing}
          isMultiMode={isMultiMode}
          selectedModels={selectedModels}
          onAgentChange={onAgentChange}
          onModelChange={onModelChange}
          handleMultiToggle={handleMultiToggle}
          handleMultiModelChange={handleMultiModelChange}
          handleImplementClick={handleImplementClick}
        />
      )}
      {isPending && showImplementButton && (
        <ImplementButton
          implementing={implementing}
          disabled={disableImplementation}
          hasAgent={hasAgent}
          isFirstPending={isFirstPending}
          pressed={implementButtonPressed}
          label={implementButtonLabel}
          onClick={handleImplementClick}
        />
      )}
      {hasExpandableContent && <button onClick={handleToggleExpand} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors" title={isExpanded ? 'Collapse details' : 'Expand details'}><motion.div animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.2 }}><ChevronDown size={16} /></motion.div></button>}
    </div>
  );
};

export interface ExpandedContentProps {
  task: PlanTask;
  draftId?: string;
}

export const ExpandedContent: React.FC<ExpandedContentProps> = ({ task, draftId }) => {
  const attachments = task.attachments || [];
  const hasAttachments = attachments.length > 0;
  const renderAttachmentIcon = () => (
    <div className="w-4 h-4 text-gray-500 flex-shrink-0">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
        <polyline points="10 9 9 9 8 9"/>
      </svg>
    </div>
  );

  return (
    <div className="px-4 pb-4 pt-0 border-t border-gray-100">
      {task.body && (
        <div className="mt-3">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Context</span>
          <div className="mt-1 text-sm text-gray-600">
            <MarkdownRenderer text={task.body} className="prose prose-sm max-w-none" />
          </div>
        </div>
      )}
      {task.implementation && (
        <div className="mt-3 bg-slate-50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <MessageSquare size={12} className="text-slate-500" />
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Implementation</span>
          </div>
          <div className="text-sm text-slate-700">
            <MarkdownRenderer text={task.implementation} className="prose prose-sm max-w-none" />
          </div>
        </div>
      )}
      {(task.notes || hasAttachments) && (
        <div className="mt-3 bg-white rounded-lg p-3 border border-dashed border-gray-300">
          <div className="flex items-center gap-2 mb-2">
            <StickyNote size={12} className="text-slate-500" />
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Notes</span>
          </div>
          {task.notes && (
            <div className="text-sm text-gray-600">
              <MarkdownRenderer text={task.notes} className="prose prose-sm max-w-none" />
            </div>
          )}
          {hasAttachments && draftId && (
            <div className={task.notes ? 'mt-3 pt-3 border-t border-gray-200' : ''}>
              <span className="text-xs font-medium text-gray-500 block mb-2">Attachments</span>
              <div className="flex flex-wrap gap-2">
                {attachments.map((attachment) => {
                  const isImage = attachment.type === 'image' || attachment.mimeType?.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(attachment.originalName);

                  return (
                    <div key={attachment.id} className="inline-flex items-center gap-2 bg-gray-100 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm">
                      {isImage ? <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0 bg-gray-200 border border-gray-300"><AuthenticatedAttachmentImage src={getAttachmentUrl(draftId, attachment.id)} alt={attachment.originalName} className="w-full h-full object-cover" /></div> : renderAttachmentIcon()}
                      <span className="text-gray-700 max-w-[150px] truncate" title={attachment.originalName}>
                        {attachment.originalName}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export interface IssueMetadataProps { issue: PlanIssue; isPending: boolean; isProcessing: boolean; selectedModels?: AgentModelPair[]; }
export const IssueMetadata: React.FC<IssueMetadataProps> = ({ issue, isPending, isProcessing, selectedModels }) => {
  const prUrl = issue.pr_number ? `https://github.com/${issue.repository}/pull/${issue.pr_number}` : null;
  const showProgressLink = isProcessing && issue.task_id;
  const showMultiAgentInfo = !isPending && selectedModels && selectedModels.length > 0;
  const showAgentInfo = !isPending && !showMultiAgentInfo && issue.agent_alias;
  if (!prUrl && !showProgressLink && issue.followup_count <= 0 && !showMultiAgentInfo && !showAgentInfo) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs sm:gap-3">
      {prUrl && <PrLink prUrl={prUrl} prNumber={issue.pr_number!} />}
      {showProgressLink && <ViewProgressLink taskId={issue.task_id!} />}
      {issue.followup_count > 0 && <span className="hidden sm:block"><FollowupCount count={issue.followup_count} /></span>}
      {showMultiAgentInfo && (
        <div className="hidden sm:flex items-center gap-1 flex-wrap">
          {selectedModels.map((m, idx) => (
            <span key={`${m.agent_alias}-${m.model_name}`} className="flex items-center gap-1 text-gray-500">{idx > 0 && <span className="text-gray-300 mx-1">|</span>}<ProviderLogo provider={m.agent_alias} className="w-3 h-3" /><span>{getModelName(m.model_name)}</span></span>
          ))}
        </div>
      )}
      {showAgentInfo && <span className="hidden sm:block"><AgentModelInfo agentAlias={issue.agent_alias!} modelName={issue.model_name} /></span>}
    </div>
  );
};
