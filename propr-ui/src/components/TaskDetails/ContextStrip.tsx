import React from 'react';
import { TaskInfo, TokenUsage } from './types';
import { ExternalLink, GitPullRequest, GitCommit, Zap } from 'lucide-react';
import { formatRelativeTime } from './utils';
import { ProviderLogo } from '../ui/ProviderLogo';

// GitHub icon component
const GitHubIcon: React.FC<{ size?: number; className?: string }> = ({ size = 14, className = '' }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    aria-hidden="true"
  >
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
  </svg>
);

// Model name mapping for human-readable names
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'claude-opus-4-5-20251101': 'Opus 4.5',
  'claude-sonnet-4-20250514': 'Sonnet 4',
  'claude-3-5-sonnet-20241022': 'Sonnet 3.5',
  'claude-3-5-haiku-20241022': 'Haiku 3.5',
  'claude-3-opus-20240229': 'Opus 3',
  'claude-3-sonnet-20240229': 'Sonnet 3',
  'claude-3-haiku-20240307': 'Haiku 3',
};

const getDisplayModelName = (modelId: string): string => {
  return MODEL_DISPLAY_NAMES[modelId] || modelId;
};

// Format token count for display (e.g., 1234 -> "1.2k", 1234567 -> "1.2M")
const formatTokenCount = (count: number | null | undefined): string => {
  if (count === null || count === undefined) return '-';
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
};

// Separator dot between items
const Dot: React.FC = () => (
  <span className="text-gray-300 mx-1.5">•</span>
);

// Repository link component
const RepoLink: React.FC<{ taskInfo: TaskInfo }> = ({ taskInfo }) => (
  <>
    <a
      href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-gray-700 hover:text-blue-600 transition-colors"
    >
      <GitHubIcon size={12} className="text-gray-500" />
      <span className="font-medium">{taskInfo.repoOwner}/{taskInfo.repoName}</span>
    </a>
    <Dot />
  </>
);

// Issue/PR number chip component
const IssuePRChip: React.FC<{ taskInfo: TaskInfo }> = ({ taskInfo }) => (
  <>
    <a
      href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/${taskInfo.type === 'pr-comment' ? 'pull' : 'issues'}/${taskInfo.number}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 bg-gray-100 text-gray-700 hover:text-blue-600 hover:bg-blue-50 px-1.5 py-0.5 rounded font-mono text-xs transition-colors"
      title={taskInfo.type === 'pr-comment' ? `Pull Request #${taskInfo.number}` : `Issue #${taskInfo.number}`}
    >
      {taskInfo.type === 'pr-comment' ? 'PR' : '#'}{taskInfo.number}
      <ExternalLink size={10} className="opacity-60" />
    </a>
    <Dot />
  </>
);

// Linked issue chip for PR tasks
const LinkedIssueChip: React.FC<{ taskInfo: TaskInfo }> = ({ taskInfo }) => {
  if (taskInfo.type !== 'pr-comment' || !taskInfo.issueNumber) return null;
  return (
    <>
      <a
        href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/issues/${taskInfo.issueNumber}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 bg-orange-50 text-orange-700 hover:bg-orange-100 px-1.5 py-0.5 rounded font-mono text-xs transition-colors"
        title={`Original Issue #${taskInfo.issueNumber}`}
      >
        #{taskInfo.issueNumber}
        <ExternalLink size={10} className="opacity-60" />
      </a>
      <Dot />
    </>
  );
};

// Model chip component
const ModelChip: React.FC<{ modelName: string; duration?: number | null }> = ({ modelName, duration }) => (
  <>
    <span
      className="inline-flex items-center gap-1 bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded font-mono text-xs"
      title={modelName}
    >
      <ProviderLogo provider={modelName} className="w-3 h-3" />
      {getDisplayModelName(modelName)}
    </span>
    {duration !== null && duration !== undefined && (
      <span className="ml-1.5 text-gray-400 font-mono text-xs">
        {formatRelativeTime(duration)}
      </span>
    )}
  </>
);

// PR info chip component
const PRInfoChip: React.FC<{ prInfo: { url?: string; number?: number } }> = ({ prInfo }) => {
  if (!prInfo.url) return null;
  return (
    <>
      <a
        href={prInfo.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 bg-green-50 text-green-700 hover:bg-green-100 px-1.5 py-0.5 rounded font-mono text-xs transition-colors"
      >
        <GitPullRequest size={10} />
        PR #{prInfo.number}
        <ExternalLink size={10} className="opacity-60" />
      </a>
      <Dot />
    </>
  );
};

// Commit info chip component
const CommitInfoChip: React.FC<{ commitInfo: { shortHash: string; url: string } }> = ({ commitInfo }) => {
  if (!commitInfo.shortHash || !commitInfo.url) return null;
  return (
    <>
      <a
        href={commitInfo.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 bg-gray-100 text-gray-600 hover:text-gray-800 hover:bg-gray-200 px-1.5 py-0.5 rounded font-mono text-xs transition-colors"
        title="View commit on GitHub"
      >
        <GitCommit size={10} />
        {commitInfo.shortHash}
      </a>
    </>
  );
};

// Token usage chip component
const TokenUsageChip: React.FC<{ tokenUsage: TokenUsage }> = ({ tokenUsage }) => {
  const inputTokens = (tokenUsage.input_tokens ?? 0) +
    (tokenUsage.cache_creation_input_tokens ?? 0) +
    (tokenUsage.cache_read_input_tokens ?? 0);
  const outputTokens = tokenUsage.output_tokens ?? 0;
  const hasTokens = inputTokens > 0 || outputTokens > 0;

  if (!hasTokens) return null;

  return (
    <span
      className="inline-flex items-center gap-1 bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded font-mono text-xs"
      title={`Input: ${tokenUsage.input_tokens ?? 0} | Output: ${tokenUsage.output_tokens ?? 0}${tokenUsage.cache_read_input_tokens ? ` | Cache Read: ${tokenUsage.cache_read_input_tokens}` : ''}${tokenUsage.cache_creation_input_tokens ? ` | Cache Creation: ${tokenUsage.cache_creation_input_tokens}` : ''}`}
    >
      <Zap size={10} />
      {formatTokenCount(inputTokens)}/{formatTokenCount(outputTokens)}
    </span>
  );
};

interface ContextStripProps {
  taskInfo: TaskInfo | null;
  modelName: string;
  prInfo?: { url?: string; number?: number };
  commitInfo?: { shortHash: string; url: string };
  duration?: number | null;
  tokenUsage?: TokenUsage;
  /** Mobile only: Show only the repository name link */
  mobileRepoOnly?: boolean;
  /** Mobile only: Show only the metadata (PR, issue, model, etc.) without repo name */
  mobileMetadataOnly?: boolean;
}

const ContextStrip: React.FC<ContextStripProps> = ({
  taskInfo,
  modelName,
  prInfo,
  commitInfo,
  duration,
  tokenUsage,
  mobileRepoOnly,
  mobileMetadataOnly,
}) => {
  // Mobile: Show only repo name
  if (mobileRepoOnly) {
    return (
      <div className="flex items-center text-sm text-gray-600 min-w-0">
        {taskInfo && (
          <a
            href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-gray-700 hover:text-blue-600 transition-colors"
          >
            <GitHubIcon size={12} className="text-gray-500" />
            <span className="font-medium truncate">{taskInfo.repoOwner}/{taskInfo.repoName}</span>
          </a>
        )}
      </div>
    );
  }

  // Mobile: Show only metadata without repo name
  if (mobileMetadataOnly) {
    return (
      <div className="flex items-center flex-wrap gap-1 text-sm text-gray-600">
        {prInfo && <PRInfoChip prInfo={prInfo} />}
        {taskInfo && <IssuePRChip taskInfo={taskInfo} />}
        {taskInfo && <LinkedIssueChip taskInfo={taskInfo} />}
        <ModelChip modelName={modelName} duration={duration} />
        {commitInfo && (
          <>
            <Dot />
            <CommitInfoChip commitInfo={commitInfo} />
          </>
        )}
        {tokenUsage && (
          <>
            <Dot />
            <TokenUsageChip tokenUsage={tokenUsage} />
          </>
        )}
      </div>
    );
  }

  // Default: Full layout
  return (
    <div className="flex items-center flex-wrap gap-y-1 text-sm text-gray-600 flex-1 min-w-0">
      {/* Left: Repo/Branch - Bold repo name */}
      <div className="flex items-center">
        {taskInfo && <RepoLink taskInfo={taskInfo} />}
      </div>

      {/* Middle: PR • Issue • Model • Duration - Separated by dots */}
      <div className="flex items-center flex-wrap">
        {prInfo && <PRInfoChip prInfo={prInfo} />}
        {taskInfo && <IssuePRChip taskInfo={taskInfo} />}
        {taskInfo && <LinkedIssueChip taskInfo={taskInfo} />}
        <ModelChip modelName={modelName} duration={duration} />
        {commitInfo && (
          <>
            <Dot />
            <CommitInfoChip commitInfo={commitInfo} />
          </>
        )}
        {tokenUsage && (
          <>
            <Dot />
            <TokenUsageChip tokenUsage={tokenUsage} />
          </>
        )}
      </div>
    </div>
  );
};

export default ContextStrip;
