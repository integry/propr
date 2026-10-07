import { Loader2 } from 'lucide-react';
import { IssueSummary } from '../api/proprApi';

/**
 * Computes the effective display status for a draft based on its status and issue summary.
 * If a draft has status 'executed' (issues created) but all issues are merged,
 * the effective status should be 'merged'.
 */
export const getEffectiveStatus = (status: string, issueSummary: IssueSummary | null | undefined): string => {
  if (status === 'executed' && issueSummary && issueSummary.total > 0) {
    if (issueSummary.merged === issueSummary.total) {
      return 'merged';
    }
  }
  return status;
};

export const formatRelativeTime = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString();
};

// "Success is Quiet": the same pill architecture as the Task list. Review-stage
// states share one neutral slate pill; color marks active work, merges and failures.
type PlanStatusTone = 'draft' | 'active' | 'review' | 'merged' | 'failed';

const getStatusTone = (status: string): PlanStatusTone => {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'executing':
    case 'generating':
    case 'refining':
      return 'active';
    case 'merged':
      return 'merged';
    case 'failed':
      return 'failed';
    default:
      return 'review';
  }
};

const STATUS_PILL_CLASSES: Record<PlanStatusTone, string> = {
  draft: 'bg-slate-100 text-slate-600 border border-slate-200',
  active: 'bg-teal-50 text-teal-700 border border-teal-200',
  review: 'bg-slate-100 text-slate-700 border border-slate-200',
  merged: 'bg-purple-50 text-purple-700 border border-purple-200',
  failed: 'bg-red-50 text-red-700 border border-red-200',
};

export const getStatusBadge = (status: string): string => STATUS_PILL_CLASSES[getStatusTone(status)];

export const getStatusLabel = (status: string): string => {
  switch (status) {
    case 'merged':
      return 'Merged';
    case 'executed':
      return 'Issues Created';
    case 'executing':
      return 'Creating Issues';
    case 'pr_created':
      return 'PR Created';
    case 'review':
      return 'In Review';
    case 'approved':
      return 'Approved';
    case 'generating':
      return 'Generating';
    case 'refining':
      return 'Refining';
    case 'draft':
      return 'Draft';
    case 'failed':
      return 'Failed';
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
};

// Pill marker: hollow dot for drafts, spinner for active work, filled dot otherwise.
export const getStatusIcon = (status: string): React.ReactNode => {
  switch (getStatusTone(status)) {
    case 'draft':
      return <span className="w-1.5 h-1.5 rounded-full border border-slate-400" aria-hidden="true" />;
    case 'active':
      return <Loader2 size={11} className="text-teal-600 animate-spin" aria-hidden="true" />;
    case 'merged':
      return <span className="w-1.5 h-1.5 rounded-full bg-purple-500" aria-hidden="true" />;
    case 'failed':
      return <span className="w-1.5 h-1.5 rounded-full bg-red-500" aria-hidden="true" />;
    default:
      return <span className="w-1.5 h-1.5 rounded-full bg-slate-400" aria-hidden="true" />;
  }
};

const getRepositoryOwner = (repository: string): string | null => (repository.includes('/') ? repository.split('/')[0] : null);

/** Whether the listed repositories span more than one owner, so short names could collide. */
export const hasMultipleRepositoryOwners = (repositories: string[]): boolean =>
  new Set(repositories.map(getRepositoryOwner).filter(Boolean)).size > 1;

/**
 * "integry/propr" reads as "propr" when every listed row shares the organization. Lists that
 * span owners keep it, so same-named forks or mirrors stay distinguishable.
 */
export const getRepositoryShortName = (repository: string, keepOwner = false): string =>
  keepOwner ? repository : repository.split('/').pop() || repository;

/**
 * Collapses a plan title (which may fall back to a raw markdown prompt) into a
 * single plain-text line so table rows never render headings or line breaks.
 */
export const toSingleLinePlainText = (value: string): string => value
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/^\s{0,3}#{1,6}\s+/gm, '')
  .replace(/\s#{1,6}\s+/g, ' ')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__|`)/g, '')
  .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
  .replace(/\s+/g, ' ')
  .trim();

const pluralize = (count: number, singular: string, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;

/** Issue counts as plain labelled tokens: "3 issues · 1 running · 2 pending". */
export const getIssueSummaryTokens = (summary: IssueSummary | null | undefined): string[] => {
  if (!summary || summary.total === 0) return [];
  const tokens = [pluralize(summary.total, 'issue')];
  if (summary.processing > 0) tokens.push(`${summary.processing} running`);
  if (summary.pending > 0) tokens.push(`${summary.pending} pending`);
  if (summary.merged > 0) tokens.push(`${summary.merged} merged`);
  if (summary.closed > 0) tokens.push(`${summary.closed} closed`);
  return tokens;
};

export const renderIssueSummary = (summary: IssueSummary | null | undefined): React.ReactNode => {
  const tokens = getIssueSummaryTokens(summary);
  if (tokens.length === 0) {
    return <span className="font-mono text-xs text-slate-400">No issues</span>;
  }

  return (
    <span className="font-mono text-xs text-slate-500 whitespace-nowrap">
      {tokens.join(' • ')}
    </span>
  );
};

/**
 * Renders the unified Status Strip combining issue metrics and status (without time)
 */
export const renderStatusStrip = (
  summary: IssueSummary | null | undefined,
  effectiveStatus: string
): React.ReactNode => {
  return (
    <div className="flex items-center gap-2.5">
      {/* Issue summary - grouped tightly */}
      {renderIssueSummary(summary)}
      {/* Separator dot */}
      <span className="text-slate-300">•</span>
      {/* Status badge */}
      <span className={`px-2 py-0.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-full ${getStatusBadge(effectiveStatus)}`}>
        {getStatusIcon(effectiveStatus)}
        {getStatusLabel(effectiveStatus)}
      </span>
    </div>
  );
};
