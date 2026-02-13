import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ExternalLink,
  GitPullRequest,
  MessageSquare,
  Play,
  Loader2,
  Eye,
  ChevronDown,
  StickyNote
} from 'lucide-react';
import { PlanIssue, PlanIssueStatus, STATUS_CONFIG, AgentModelPair } from '../../api/planIssuesApi';
import { AgentConfig, getAttachmentUrl } from '../../api/gitfixApi';
import { PlanTask } from '../../api/plannerApi';
import { ProviderLogo } from '../ui/ProviderLogo';
import AgentModelSelector from './AgentModelSelector';
import MarkdownRenderer from '../TaskDetails/MarkdownRenderer';
import { getModelName, getImplementButtonClassName, getImplementButtonTitle } from './planIssueRowUtils';

export const StatusBadge: React.FC<{ status: PlanIssueStatus }> = ({ status }) => {
  const config = STATUS_CONFIG[status];

  return (
    <span
      className={`
        inline-flex items-center gap-1.5
        px-2 py-0.5
        text-xs font-medium
        rounded-full border
        ${config.color} ${config.bgColor} ${config.borderColor}
      `}
    >
      {config.isActive && (
        <span className="relative flex h-2 w-2">
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.bgColor} opacity-75`}></span>
          <span className={`relative inline-flex rounded-full h-2 w-2 ${config.bgColor.replace('100', '500')}`}></span>
        </span>
      )}
      {config.label}
    </span>
  );
};

export interface ImplementButtonProps {
  implementing: boolean;
  hasAgent: boolean;
  isFirstPending: boolean;
  onClick: () => void;
}

export const ImplementButton: React.FC<ImplementButtonProps> = ({ implementing, hasAgent, isFirstPending, onClick }) => (
  <button
    onClick={onClick}
    disabled={implementing || !hasAgent}
    className={`
      flex items-center gap-1.5
      px-3 py-1.5
      text-sm font-medium
      rounded-md
      transition-colors
      ${getImplementButtonClassName(implementing, hasAgent, isFirstPending)}
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
        <span>Implement</span>
      </>
    )}
  </button>
);

export interface AgentModelInfoProps {
  agentAlias: string;
  modelName: string | null;
}

export const AgentModelInfo: React.FC<AgentModelInfoProps> = ({ agentAlias, modelName }) => (
  <span className="flex items-center gap-1.5 text-gray-500">
    <ProviderLogo provider={agentAlias} className="w-3 h-3" />
    <span>{agentAlias}</span>
    {modelName && (
      <>
        <span className="text-gray-300">/</span>
        <span>{getModelName(modelName)}</span>
      </>
    )}
  </span>
);

export interface PrLinkProps {
  prUrl: string;
  prNumber: number;
}

export const PrLink: React.FC<PrLinkProps> = ({ prUrl, prNumber }) => (
  <a
    href={prUrl}
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center gap-1 font-mono text-xs px-1.5 py-0.5 bg-purple-50 border border-purple-200 rounded-sm text-purple-700 hover:bg-purple-100 hover:border-purple-300 transition-colors"
    onClick={(e) => e.stopPropagation()}
  >
    <GitPullRequest size={12} />
    <span>PR #{prNumber}</span>
    <ExternalLink size={10} className="opacity-50" />
  </a>
);

export interface FollowupCountProps {
  count: number;
}

export const FollowupCount: React.FC<FollowupCountProps> = ({ count }) => (
  <span className="flex items-center gap-1 text-gray-500">
    <MessageSquare size={12} />
    {count} follow-up{count !== 1 ? 's' : ''}
  </span>
);

export interface ViewProgressLinkProps {
  taskId: string;
}

export const ViewProgressLink: React.FC<ViewProgressLinkProps> = ({ taskId }) => (
  <Link
    to={`/tasks/${taskId}`}
    className="inline-flex items-center gap-1 font-mono text-xs px-1.5 py-0.5 bg-blue-50 border border-blue-200 rounded-sm text-blue-700 hover:bg-blue-100 hover:border-blue-300 transition-colors"
    onClick={(e) => e.stopPropagation()}
  >
    <Eye size={12} />
    View Progress
  </Link>
);

export interface RowActionsProps {
  isPending: boolean;
  hasExpandableContent: boolean;
  isExpanded: boolean;
  implementing: boolean;
  isMultiMode: boolean;
  selectedModels: AgentModelPair[];
  hasAgent: boolean;
  isFirstPending: boolean;
  agents: AgentConfig[];
  issue: PlanIssue;
  onAgentChange: (issueNumber: number, agentAlias: string | null) => void;
  onModelChange: (issueNumber: number, modelName: string | null) => void;
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
  handleMultiToggle,
  handleMultiModelChange,
  handleImplementClick,
  handleToggleExpand
}) => (
  <div className="flex items-center gap-3 flex-shrink-0">
    {isPending && (
      <AgentModelSelector
        agents={agents}
        selectedAgent={issue.agent_alias}
        selectedModel={issue.model_name}
        onAgentChange={(agent) => onAgentChange(issue.issue_number, agent)}
        onModelChange={(model) => onModelChange(issue.issue_number, model)}
        disabled={implementing}
        compact
        isMulti={isMultiMode}
        onMultiToggle={handleMultiToggle}
        selectedModels={selectedModels}
        onMultiModelChange={handleMultiModelChange}
        onMultiConfirm={handleImplementClick}
      />
    )}

    {isPending && (
      <ImplementButton
        implementing={implementing}
        hasAgent={hasAgent}
        isFirstPending={isFirstPending}
        onClick={handleImplementClick}
      />
    )}

{/* Status badge already shows status, no need for redundant "In Progress" text */}

    {/* Expand/Collapse Toggle */}
    {hasExpandableContent && (
      <button
        onClick={handleToggleExpand}
        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
        title={isExpanded ? 'Collapse details' : 'Expand details'}
      >
        <motion.div
          animate={{ rotate: isExpanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <ChevronDown size={16} />
        </motion.div>
      </button>
    )}
  </div>
);

export interface ExpandedContentProps {
  task: PlanTask;
  draftId?: string;
}

export const ExpandedContent: React.FC<ExpandedContentProps> = ({ task, draftId }) => {
  const attachments = task.attachments || [];
  const hasAttachments = attachments.length > 0;

  return (
    <div className="px-4 pb-4 pt-0 border-t border-gray-100">
      {/* Context / Body */}
      {task.body && (
        <div className="mt-3">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Context</span>
          <div className="mt-1 text-sm text-gray-600">
            <MarkdownRenderer text={task.body} className="prose prose-sm max-w-none" />
          </div>
        </div>
      )}

      {/* Implementation */}
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

      {/* Notes */}
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
          {/* Attachments */}
          {hasAttachments && draftId && (
            <div className={task.notes ? 'mt-3 pt-3 border-t border-gray-200' : ''}>
              <span className="text-xs font-medium text-gray-500 block mb-2">Attachments</span>
              <div className="flex flex-wrap gap-2">
                {attachments.map((attachment) => {
                  const isImage = attachment.type === 'image' || attachment.mimeType?.startsWith('image/') ||
                    /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(attachment.originalName);

                  return (
                    <div key={attachment.id} className="inline-flex items-center gap-2 bg-gray-100 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm">
                      {isImage ? (
                        <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0 bg-gray-200 border border-gray-300">
                          <img
                            src={getAttachmentUrl(draftId, attachment.id)}
                            alt={attachment.originalName}
                            className="w-full h-full object-cover"
                            crossOrigin="use-credentials"
                          />
                        </div>
                      ) : (
                        <div className="w-4 h-4 text-gray-500 flex-shrink-0">
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                            <polyline points="10 9 9 9 8 9"/>
                          </svg>
                        </div>
                      )}
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

export interface IssueMetadataProps {
  issue: PlanIssue;
  isPending: boolean;
  isProcessing: boolean;
  /** Selected models for multi-agent implementation */
  selectedModels?: AgentModelPair[];
}

export const IssueMetadata: React.FC<IssueMetadataProps> = ({ issue, isPending, isProcessing, selectedModels }) => {
  const prUrl = issue.pr_number
    ? `https://github.com/${issue.repository}/pull/${issue.pr_number}`
    : null;
  const showProgressLink = isProcessing && issue.task_id;
  // Show multi-agent info during processing if we have selected models
  const showMultiAgentInfo = !isPending && selectedModels && selectedModels.length > 0;
  // Show single agent info only if we're not showing multi-agent and we have an agent
  const showAgentInfo = !isPending && !showMultiAgentInfo && issue.agent_alias;

  // If no metadata to show, return null
  if (!prUrl && !showProgressLink && issue.followup_count <= 0 && !showMultiAgentInfo && !showAgentInfo) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 text-xs">
      {prUrl && <PrLink prUrl={prUrl} prNumber={issue.pr_number!} />}
      {showProgressLink && <ViewProgressLink taskId={issue.task_id!} />}
      {issue.followup_count > 0 && <FollowupCount count={issue.followup_count} />}
      {showMultiAgentInfo && (
        <div className="flex items-center gap-1 flex-wrap">
          {selectedModels.map((m, idx) => (
            <span key={`${m.agent_alias}-${m.model_name}`} className="flex items-center gap-1 text-gray-500">
              {idx > 0 && <span className="text-gray-300 mx-1">|</span>}
              <ProviderLogo provider={m.agent_alias} className="w-3 h-3" />
              <span>{getModelName(m.model_name)}</span>
            </span>
          ))}
        </div>
      )}
      {showAgentInfo && (
        <AgentModelInfo agentAlias={issue.agent_alias!} modelName={issue.model_name} />
      )}
    </div>
  );
};
