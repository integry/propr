import React from 'react';
import { motion } from 'framer-motion';
import {
  ExternalLink,
  GitPullRequest,
  MessageSquare,
  Play,
  Loader2
} from 'lucide-react';
import { PlanIssue, PlanIssueStatus, STATUS_CONFIG } from '../../api/planIssuesApi';
import { AgentConfig } from '../../api/gitfixApi';
import { ProviderLogo } from '../ui/ProviderLogo';
import { MODEL_INFO_MAP } from '../../config/modelDefinitions';
import AgentModelSelector from './AgentModelSelector';

interface PlanIssueRowProps {
  issue: PlanIssue;
  issueTitle?: string;
  agents: AgentConfig[];
  onImplement: (issueNumber: number) => void;
  onAgentChange: (issueNumber: number, agentAlias: string | null) => void;
  onModelChange: (issueNumber: number, modelName: string | null) => void;
  implementing?: boolean;
  isFirstPending?: boolean;
  onImplementWithWarning?: (issueNumber: number) => void;
}

const StatusBadge: React.FC<{ status: PlanIssueStatus }> = ({ status }) => {
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

const getModelName = (modelId: string | null): string => {
  if (!modelId) return '';
  const modelInfo = MODEL_INFO_MAP[modelId];
  return modelInfo?.name || modelId;
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

interface ImplementButtonProps {
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

const ImplementButton: React.FC<ImplementButtonProps> = ({ implementing, hasAgent, isFirstPending, onClick }) => (
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

interface AgentModelInfoProps {
  agentAlias: string;
  modelName: string | null;
}

const AgentModelInfo: React.FC<AgentModelInfoProps> = ({ agentAlias, modelName }) => (
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

interface PrLinkProps {
  prUrl: string;
  prNumber: number;
}

const PrLink: React.FC<PrLinkProps> = ({ prUrl, prNumber }) => (
  <a
    href={prUrl}
    target="_blank"
    rel="noopener noreferrer"
    className="flex items-center gap-1 text-purple-600 hover:text-purple-800"
  >
    <GitPullRequest size={12} />
    PR #{prNumber}
    <ExternalLink size={10} className="opacity-50" />
  </a>
);

interface FollowupCountProps {
  count: number;
}

const FollowupCount: React.FC<FollowupCountProps> = ({ count }) => (
  <span className="flex items-center gap-1 text-gray-500">
    <MessageSquare size={12} />
    {count} follow-up{count !== 1 ? 's' : ''}
  </span>
);

export const PlanIssueRow: React.FC<PlanIssueRowProps> = ({
  issue,
  issueTitle,
  agents,
  onImplement,
  onAgentChange,
  onModelChange,
  implementing = false,
  isFirstPending = true,
  onImplementWithWarning
}) => {
  const isPending = issue.status === 'pending';
  const isActive = STATUS_CONFIG[issue.status]?.isActive || false;
  const isMerged = issue.status === 'merged';

  const issueUrl = `https://github.com/${issue.repository}/issues/${issue.issue_number}`;
  const prUrl = issue.pr_number
    ? `https://github.com/${issue.repository}/pull/${issue.pr_number}`
    : null;

  const containerClassName = isMerged
    ? 'bg-gray-50 border-gray-200'
    : 'bg-white border-gray-200';

  const titleClassName = isMerged ? 'text-gray-500' : 'text-gray-600';
  const showAgentInfo = !isPending && issue.agent_alias;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`border rounded-lg overflow-hidden ${containerClassName}`}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <a
                href={issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-gray-900 hover:text-primary-600 truncate flex items-center gap-1"
              >
                #{issue.issue_number}
                <ExternalLink size={12} className="flex-shrink-0 opacity-50" />
              </a>
              <StatusBadge status={issue.status} />
            </div>

            {issueTitle && (
              <p className={`text-sm ${titleClassName} truncate`}>
                {issueTitle}
              </p>
            )}

            <div className="flex items-center gap-4 mt-2 text-xs">
              {prUrl && <PrLink prUrl={prUrl} prNumber={issue.pr_number!} />}
              {issue.followup_count > 0 && <FollowupCount count={issue.followup_count} />}
              {showAgentInfo && (
                <AgentModelInfo agentAlias={issue.agent_alias!} modelName={issue.model_name} />
              )}
            </div>
          </div>

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
              />
            )}

            {isPending && (
              <ImplementButton
                implementing={implementing}
                hasAgent={!!issue.agent_alias}
                isFirstPending={isFirstPending}
                onClick={() => {
                  if (isFirstPending || !onImplementWithWarning) {
                    onImplement(issue.issue_number);
                  } else {
                    onImplementWithWarning(issue.issue_number);
                  }
                }}
              />
            )}

            {isActive && !isPending && (
              <div className="flex items-center gap-1.5 text-sm text-blue-600">
                <Loader2 size={14} className="animate-spin" />
                <span>In Progress</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default PlanIssueRow;
