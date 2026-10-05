import React from 'react';
import { TaskInfo, TokenUsage, UsageMetricRecord } from './types';
import { ExternalLink, GitPullRequest, GitCommit, Layers3 } from 'lucide-react';
import { formatRelativeTime } from './utils';
import { getDisplayTitle } from './taskHeaderText';
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
  if (count >= 1000000) return `${Number((count / 1000000).toFixed(1))}M`;
  if (count >= 1000) return `${Number((count / 1000).toFixed(1))}k`;
  return count.toString();
};

/**
 * Each domain is a cluster of chips set apart by whitespace; a hairline rule
 * stands between clusters. Chips carry their own boundaries, so no dot or
 * bullet separates them.
 */
const ContextGroup: React.FC<{ label: string; divided?: boolean; children: React.ReactNode }> = ({ label, divided, children }) => {
  const items = React.Children.toArray(children);
  if (!items.length) return null;
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      {divided && <span aria-hidden="true" data-testid="context-divider" className="mr-1.5 inline-block h-3 w-px flex-none self-center bg-slate-200 align-middle" />}
      {items}
    </div>
  );
};

// Repository link component
const RepoLink: React.FC<{ taskInfo: TaskInfo }> = ({ taskInfo }) => (
  <>
    <a
      href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-w-0 items-center gap-1 text-gray-700 hover:text-blue-600 transition-colors"
    >
      <GitHubIcon size={12} className="text-gray-500" />
      <span className="font-medium break-all">{taskInfo.repoOwner}/{taskInfo.repoName}</span>
    </a>
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
    </>
  );
};

// Model chip component
const ModelChip: React.FC<{ modelName: string; duration?: number | null; synthetic?: boolean }> = ({ modelName, duration, synthetic }) => (
  <>
    <span
      className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800"
      title={modelName}
    >
      {synthetic
        ? <Layers3 className="h-3 w-3" aria-label="Synthetic pool" />
        : <ProviderLogo provider={modelName} className="w-3 h-3" />}
      {getDisplayModelName(modelName)}
    </span>
    {duration !== null && duration !== undefined && (
      <span className="text-gray-500 font-mono text-xs">{formatRelativeTime(duration)}</span>
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
      className="inline-flex items-center gap-1.5 text-slate-500 font-mono text-xs"
      title={`Input: ${tokenUsage.input_tokens ?? 0} | Output: ${tokenUsage.output_tokens ?? 0}${tokenUsage.cache_read_input_tokens ? ` | Cache Read: ${tokenUsage.cache_read_input_tokens}` : ''}${tokenUsage.cache_creation_input_tokens ? ` | Cache Creation: ${tokenUsage.cache_creation_input_tokens}` : ''}`}
    >
      <span aria-label={`${formatTokenCount(inputTokens)} input tokens`}>↑{formatTokenCount(inputTokens)}</span>
      <span aria-label={`${formatTokenCount(outputTokens)} output tokens`}>↓{formatTokenCount(outputTokens)}</span>
    </span>
  );
};

// Map of raw Agent Tank metric keys to human-readable labels
const METRIC_KEY_LABELS: Record<string, string> = {
  session: 'Session', weeklyAll: 'Weekly', weeklySonnet: 'Sonnet',
  weeklyFable: 'Fable',
  weeklyOpus: 'Opus', weeklyHaiku: 'Haiku', fiveHour: 'Five Hour',
  weekly: 'Weekly', daily: 'Daily', monthly: 'Monthly',
};

function humanizeMetricKey(key: string): string {
  if (METRIC_KEY_LABELS[key]) return METRIC_KEY_LABELS[key];
  if (/^[A-Z]/.test(key)) return key;
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

// Match a metric record by raw or humanized key
function findMetricRecord(records: UsageMetricRecord[], rawKey: string): UsageMetricRecord | undefined {
  const humanized = METRIC_KEY_LABELS[rawKey] || rawKey;
  return records.find(r => r.metricKey === rawKey || r.metricKey === humanized);
}

// Usage metrics chip component (Agent Tank tracking)
const UsageMetricsChip: React.FC<{ usageMetricRecords: UsageMetricRecord[] }> = ({ usageMetricRecords }) => {
  if (!usageMetricRecords || usageMetricRecords.length === 0) return null;

  // Find the session usage (most relevant for current task)
  const sessionRecord = findMetricRecord(usageMetricRecords, 'session');
  const weeklyRecord = findMetricRecord(usageMetricRecords, 'weeklyAll') || findMetricRecord(usageMetricRecords, 'weekly');

  if (!sessionRecord && !weeklyRecord) return null;

  const sessionPct = sessionRecord?.metricValue ?? 0;
  const weeklyPct = weeklyRecord?.metricValue ?? 0;

  // Build tooltip with all metrics using human-readable labels
  const tooltip = usageMetricRecords
    .map(r => `${humanizeMetricKey(r.metricKey)}: ${r.metricValue.toFixed(1)}%`)
    .join(' | ');

  // Only show if there's actual usage
  if (sessionPct === 0 && weeklyPct === 0) return null;

  // One quota reads `(0.4% quota)`, its kind in the tooltip; both name theirs.
  const both = sessionPct > 0 && weeklyPct > 0;
  const tone = (pct: number) => pct > 25 ? 'text-amber-600 font-medium' : 'text-slate-500';
  return (
    <span className="font-mono text-xs text-slate-500" title={`Usage consumed: ${tooltip}`}>
      (
      {sessionPct > 0 && <span className={tone(sessionPct)}>{sessionPct.toFixed(1)}% {both ? 'session' : 'quota'}</span>}
      {both && ', '}
      {weeklyPct > 0 && <span className={tone(weeklyPct)}>{weeklyPct.toFixed(1)}% {both ? 'weekly' : 'quota'}</span>}
      )
    </span>
  );
};

/** How the run went: what leads the line, then the model and runtime, then consumption. */
const TelemetryGroups: React.FC<{
  modelName: string;
  duration?: number | null;
  synthetic?: boolean;
  tokenUsage?: TokenUsage;
  usageMetricRecords?: UsageMetricRecord[];
  lead?: React.ReactNode;
  divided: boolean;
}> = ({ modelName, duration, synthetic, tokenUsage, usageMetricRecords, lead, divided }) => {
  const hasTokens = tokenUsage && Object.values(tokenUsage).some(value => (value ?? 0) > 0);
  const hasQuota = usageMetricRecords?.some(record => record.metricValue > 0 &&
    ['session', 'Session', 'weeklyAll', 'weekly', 'Weekly'].includes(record.metricKey));
  return (
    <>
      {lead && (
        <ContextGroup label="Run">
          <span className="min-w-0 text-gray-700">{lead}</span>
        </ContextGroup>
      )}
      <ContextGroup label="Execution runtime" divided={divided}>
        <ModelChip modelName={modelName} duration={duration} synthetic={synthetic} />
      </ContextGroup>
      {(hasTokens || hasQuota) && (
        <ContextGroup label="Consumption" divided>
          {hasTokens && <TokenUsageChip tokenUsage={tokenUsage} />}
          {hasQuota && <UsageMetricsChip usageMetricRecords={usageMetricRecords!} />}
        </ContextGroup>
      )}
    </>
  );
};

/**
 * The collapsed mobile header's one line: the pull request, then the task's
 * title, truncated. Scrolled down a task, the title is what you lose track of;
 * the repository is only the fallback for a task without one.
 */
const CompactTitleLine: React.FC<{ taskInfo: TaskInfo | null; prInfo?: { url?: string; number?: number } }> = ({ taskInfo, prInfo }) => {
  const pr = prInfo?.url
    ? { url: prInfo.url, number: prInfo.number }
    : taskInfo?.type === 'pr-comment' && taskInfo.number
      ? { url: `https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}/pull/${taskInfo.number}`, number: taskInfo.number }
      : null;
  const title = getDisplayTitle(taskInfo?.title);
  const repo = taskInfo ? `${taskInfo.repoOwner}/${taskInfo.repoName}` : undefined;
  const label = title.text || repo;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
      {pr && (
        <span className="flex flex-none items-center font-mono text-xs text-green-700">
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`PR #${pr.number}`}
            className="inline-flex items-center gap-1 rounded py-0.5 transition-colors hover:underline"
          >
            <GitPullRequest size={12} aria-hidden="true" />
            #{pr.number}
          </a>
          {label && <span aria-hidden="true">:</span>}
        </span>
      )}
      {label && (
        <span className="min-w-0 truncate font-medium text-gray-900" title={title.text ? title.tooltip : repo}>
          {label}
        </span>
      )}
    </div>
  );
};

interface ContextStripProps {
  taskInfo: TaskInfo | null;
  modelName: string;
  prInfo?: { url?: string; number?: number };
  commitInfo?: { shortHash: string; url: string };
  duration?: number | null;
  tokenUsage?: TokenUsage;
  usageMetricRecords?: UsageMetricRecord[];
  synthetic?: boolean;
  /** Mobile only: Show only the repository name link */
  mobileRepoOnly?: boolean;
  /** Mobile only: Show only the metadata (PR, issue, model, etc.) without repo name */
  mobileMetadataOnly?: boolean;
  /** Mobile only: the collapsed header's one line, the pull request then the task's title, truncated. */
  mobileCompact?: boolean;
  /**
   * One half of the strip: `git` is where the task lives (repo, PR, issue,
   * commit), `telemetry` is how its run went (model, duration, consumption).
   */
  part?: 'git' | 'telemetry';
  /** Telemetry only: what leads the line, e.g. which run it describes. */
  lead?: React.ReactNode;
}

const ContextStrip: React.FC<ContextStripProps> = ({
  taskInfo,
  modelName,
  prInfo,
  commitInfo,
  duration,
  tokenUsage,
  usageMetricRecords,
  synthetic,
  mobileRepoOnly,
  mobileMetadataOnly,
  mobileCompact,
  part,
  lead,
}) => {
  if (mobileCompact) return <CompactTitleLine taskInfo={taskInfo} prInfo={prInfo} />;

  // Mobile: Show only repo name
  if (mobileRepoOnly) {
    return (
      <div className="flex items-center text-sm text-gray-600 min-w-0">
        {taskInfo && (
          <a
            href={`https://github.com/${taskInfo.repoOwner}/${taskInfo.repoName}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1 text-gray-700 hover:text-blue-600 transition-colors"
          >
            <GitHubIcon size={12} className="text-gray-500" />
            <span className="font-medium truncate">{taskInfo.repoOwner}/{taskInfo.repoName}</span>
          </a>
        )}
      </div>
    );
  }

  const showGit = part !== 'telemetry';
  const showTelemetry = part !== 'git';
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-sm text-gray-600${part === 'git' ? '' : ' flex-1'}`}>
      {showGit && (
        <ContextGroup label="Git context">
          {!mobileMetadataOnly && taskInfo && <RepoLink taskInfo={taskInfo} />}
          {prInfo?.url && <PRInfoChip prInfo={prInfo} />}
          {Boolean(taskInfo?.number) && <IssuePRChip taskInfo={taskInfo!} />}
          {taskInfo?.type === 'pr-comment' && Boolean(taskInfo.issueNumber) && <LinkedIssueChip taskInfo={taskInfo} />}
          {commitInfo?.shortHash && commitInfo.url && <CommitInfoChip commitInfo={commitInfo} />}
        </ContextGroup>
      )}
      {showTelemetry && (
        <TelemetryGroups
          modelName={modelName}
          duration={duration}
          synthetic={synthetic}
          tokenUsage={tokenUsage}
          usageMetricRecords={usageMetricRecords}
          lead={lead}
          divided={showGit || Boolean(lead)}
        />
      )}
    </div>
  );
};

export default ContextStrip;
