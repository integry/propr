import { CheckCircle, Clock, Loader2, XCircle, AlertCircle, Play, Settings2, GitMerge, GitPullRequestArrow } from 'lucide-react';
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

// "Success is Quiet": standard progression states share one neutral slate treatment.
// Color is reserved for active work (teal) and states needing attention (amber).
export const getStatusBadge = (status: string): string => {
  switch (status) {
    case 'merged':
      return 'text-slate-500';
    case 'executing':
    case 'generating':
    case 'refining':
      return 'bg-teal-50 text-teal-700';
    case 'draft':
      return 'bg-transparent border border-amber-400 text-amber-600';
    default:
      return 'bg-slate-100 text-slate-600';
  }
};

export const getStatusLabel = (status: string): string => {
  switch (status) {
    case 'merged':
      return '✓ Merged';
    case 'executed':
      return 'Issues created';
    case 'executing':
      return 'Creating issues';
    case 'pr_created':
      return 'PR Created';
    case 'review':
      return 'Ready for Review';
    case 'generating':
      return 'Generating';
    case 'refining':
      return 'Refining';
    case 'draft':
      return 'Draft';
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
};

export const getStatusIcon = (status: string): React.ReactNode => {
  switch (status) {
    case 'merged':
      // Quiet Success: no icon, checkmark is in the label
      return null;
    case 'executed':
      return <CheckCircle size={12} className="text-slate-500" />;
    case 'pr_created':
      return <GitPullRequestArrow size={12} className="text-slate-500" />;
    case 'review':
      return <Settings2 size={12} className="text-slate-500" />;
    case 'executing':
    case 'generating':
    case 'refining':
      return <Loader2 size={12} className="text-teal-600 animate-spin" />;
    case 'draft':
      return <Clock size={12} className="text-amber-500" />;
    default:
      return <Clock size={12} className="text-slate-500" />;
  }
};

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

export const renderIssueSummary = (summary: IssueSummary | null | undefined): React.ReactNode => {
  if (!summary || summary.total === 0) {
    return <span className="text-gray-400 text-xs">No issues</span>;
  }

  return (
    <div className="flex items-center gap-1.5 text-xs">
      {/* Total issues - grouped tightly */}
      <span className="flex items-center gap-0.5 text-gray-500">
        <AlertCircle size={11} />
        {summary.total}
      </span>
      {summary.processing > 0 && (
        <span className="flex items-center gap-0.5 text-blue-600" title="Processing">
          <Play size={11} />
          {summary.processing}
        </span>
      )}
      {summary.pending > 0 && (
        <span className="flex items-center gap-0.5 text-yellow-600" title="Pending">
          <Clock size={11} />
          {summary.pending}
        </span>
      )}
      {summary.merged > 0 && (
        <span className="flex items-center gap-0.5 text-slate-500" title="Merged">
          <GitMerge size={11} />
          {summary.merged}
        </span>
      )}
      {summary.closed > 0 && (
        <span className="flex items-center gap-0.5 text-red-600" title="Closed">
          <XCircle size={11} />
          {summary.closed}
        </span>
      )}
    </div>
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
      <span className="text-slate-300">·</span>
      {/* Status badge */}
      <span className={`px-2 py-0.5 inline-flex items-center gap-1 text-xs leading-5 font-medium rounded-full ${getStatusBadge(effectiveStatus)}`}>
        {getStatusIcon(effectiveStatus)}
        {getStatusLabel(effectiveStatus)}
      </span>
    </div>
  );
};
