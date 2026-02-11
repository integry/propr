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
import { AgentConfig } from '../../api/gitfixApi';
import { PlanTask } from '../../api/plannerApi';
import { ProviderLogo } from '../ui/ProviderLogo';
import AgentModelSelector from './AgentModelSelector';
import MarkdownRenderer from '../TaskDetails/MarkdownRenderer';
import { getModelName } from './planIssueRowUtils';

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

const getImplementButtonClassName = (implementing: boolean, hasAgent: boolean, isFirstPending: boolean): string => {
  if (implementing || !hasAgent) {
    return 'bg-gray-100 text-gray-400 cursor-not-allowed';
  }
  if (!isFirstPending) {
    return 'bg-gray-200 text-gray-500 hover:bg-gray-300 border border-gray-300';
  }
  return 'bg-primary-600 text-white hover:bg-primary-700';
};

export interface ImplementButtonProps {
  implementing: boolean;
  hasAgent: boolean;
  isFirstPending: boolean;
  onClick: () => void;
}

const getImplementButtonTitle = (hasAgent: boolean, isFirstPending: boolean): string => {
  if (!hasAgent) return 'Select an agent first';
  if (!isFirstPending) return 'Previous tasks not yet merged - click to implement anyway';
  return 'Start AI implementation';
};

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
    className="inline-flex items-center gap-1.5 font-mono text-xs px-2 py-0.5 bg-purple-50 border border-purple-200 rounded text-purple-700 hover:bg-purple-100 hover:border-purple-300 transition-colors"
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
    className="inline-flex items-center gap-1.5 font-mono text-xs px-2 py-0.5 bg-blue-50 border border-blue-200 rounded text-blue-700 hover:bg-blue-100 hover:border-blue-300 transition-colors"
    onClick={(e) => e.stopPropagation()}
  >
    <Eye size={12} />
    View Progress
  </Link>
);

export interface RowActionsProps {
  isPending: boolean;
  isActive: boolean;
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
  isActive,
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

    {isActive && !isPending && (
      <div className="flex items-center gap-1.5 text-sm text-blue-600">
        <Loader2 size={14} className="animate-spin" />
        <span>In Progress</span>
      </div>
    )}

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
}

export const ExpandedContent: React.FC<ExpandedContentProps> = ({ task }) => (
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
    {task.notes && (
      <div className="mt-3 bg-white rounded-lg p-3 border border-dashed border-gray-300">
        <div className="flex items-center gap-2 mb-2">
          <StickyNote size={12} className="text-slate-500" />
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Notes</span>
        </div>
        <div className="text-sm text-gray-600">
          <MarkdownRenderer text={task.notes} className="prose prose-sm max-w-none" />
        </div>
      </div>
    )}
  </div>
);

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
