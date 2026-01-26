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

export const PlanIssueRow: React.FC<PlanIssueRowProps> = ({
  issue,
  issueTitle,
  agents,
  onImplement,
  onAgentChange,
  onModelChange,
  implementing = false
}) => {
  const isPending = issue.status === 'pending';
  const isActive = STATUS_CONFIG[issue.status]?.isActive || false;
  const isMerged = issue.status === 'merged';

  // Get GitHub URLs
  const issueUrl = `https://github.com/${issue.repository}/issues/${issue.issue_number}`;
  const prUrl = issue.pr_number
    ? `https://github.com/${issue.repository}/pull/${issue.pr_number}`
    : null;

  // Get model display name
  const getModelName = (modelId: string | null): string => {
    if (!modelId) return '';
    const modelInfo = MODEL_INFO_MAP[modelId];
    return modelInfo?.name || modelId;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`
        border rounded-lg overflow-hidden
        ${isMerged ? 'bg-gray-50 border-gray-200' : 'bg-white border-gray-200'}
      `}
    >
      {/* Main Row Content */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-4">
          {/* Left: Issue Info */}
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
              <p className={`text-sm ${isMerged ? 'text-gray-500' : 'text-gray-600'} truncate`}>
                {issueTitle}
              </p>
            )}

            {/* PR Link and Follow-up Count */}
            <div className="flex items-center gap-4 mt-2 text-xs">
              {prUrl && (
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-purple-600 hover:text-purple-800"
                >
                  <GitPullRequest size={12} />
                  PR #{issue.pr_number}
                  <ExternalLink size={10} className="opacity-50" />
                </a>
              )}

              {issue.followup_count > 0 && (
                <span className="flex items-center gap-1 text-gray-500">
                  <MessageSquare size={12} />
                  {issue.followup_count} follow-up{issue.followup_count !== 1 ? 's' : ''}
                </span>
              )}

              {/* Agent/Model Info (when already set and not pending) */}
              {!isPending && issue.agent_alias && (
                <span className="flex items-center gap-1.5 text-gray-500">
                  <ProviderLogo provider={issue.agent_alias} className="w-3 h-3" />
                  <span>{issue.agent_alias}</span>
                  {issue.model_name && (
                    <>
                      <span className="text-gray-300">/</span>
                      <span>{getModelName(issue.model_name)}</span>
                    </>
                  )}
                </span>
              )}
            </div>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-3 flex-shrink-0">
            {/* Agent/Model Selector (only for pending issues) */}
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

            {/* Implement Button (only for pending issues) */}
            {isPending && (
              <button
                onClick={() => onImplement(issue.issue_number)}
                disabled={implementing || !issue.agent_alias}
                className={`
                  flex items-center gap-1.5
                  px-3 py-1.5
                  text-sm font-medium
                  rounded-md
                  transition-colors
                  ${implementing
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    : issue.agent_alias
                      ? 'bg-primary-600 text-white hover:bg-primary-700'
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  }
                `}
                title={!issue.agent_alias ? 'Select an agent first' : 'Start AI implementation'}
              >
                {implementing ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    <span>Starting...</span>
                  </>
                ) : (
                  <>
                    <Play size={14} />
                    <span>Implement</span>
                  </>
                )}
              </button>
            )}

            {/* Status Indicator for Active Issues */}
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
