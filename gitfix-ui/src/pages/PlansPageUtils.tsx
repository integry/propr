import React from 'react';
import { CheckCircle, Clock, Loader2, GitPullRequest, XCircle, AlertCircle, Play, Settings2, GitMerge, GitPullRequestArrow } from 'lucide-react';
import { IssueSummary } from '../api/gitfixApi';

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

export const getStatusBadge = (status: string): string => {
  switch (status) {
    case 'merged':
      // Quiet Success: muted gray for completed work
      return 'bg-gray-100 text-gray-500';
    case 'executed':
      // Active status: Brand Teal
      return 'bg-teal-100 text-teal-800';
    case 'pr_created':
      // Active status: Brand Teal
      return 'bg-teal-100 text-teal-800';
    case 'review':
      // Active status: Brand Teal
      return 'bg-teal-100 text-teal-800';
    case 'generating':
    case 'refining':
      // Active status: Brand Teal
      return 'bg-teal-100 text-teal-800';
    case 'draft':
      // Draft status: amber outline
      return 'bg-transparent border border-amber-400 text-amber-600';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};

export const getStatusLabel = (status: string): string => {
  switch (status) {
    case 'merged':
      return 'Merged';
    case 'executed':
      return 'Issues created';
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
      // Quiet Success: muted gray for completed work
      return <GitMerge size={12} className="text-gray-400" />;
    case 'executed':
      // Active status: Brand Teal
      return <CheckCircle size={12} className="text-teal-600" />;
    case 'pr_created':
      // Active status: Brand Teal
      return <GitPullRequestArrow size={12} className="text-teal-600" />;
    case 'review':
      // Active status: Brand Teal
      return <Settings2 size={12} className="text-teal-600" />;
    case 'generating':
    case 'refining':
      // Active status: Brand Teal
      return <Loader2 size={12} className="text-teal-600 animate-spin" />;
    case 'draft':
      // Draft status: amber
      return <Clock size={12} className="text-amber-500" />;
    default:
      return <Clock size={12} className="text-gray-500" />;
  }
};

export const renderIssueSummary = (summary: IssueSummary | null | undefined): React.ReactNode => {
  if (!summary || summary.total === 0) {
    return <span className="text-gray-400 text-sm font-mono">No issues</span>;
  }

  // Build metrics array for the Metrics Zone
  const metrics: React.ReactNode[] = [];

  // Total issues - always shown
  metrics.push(
    <span key="total" className="font-mono text-gray-600" title="Total Issues">
      [ <span className="font-mono">{summary.total}</span> Issues ]
    </span>
  );

  // Processing - shown if > 0, using ⟳ symbol
  if (summary.processing > 0) {
    metrics.push(
      <span key="processing" className="font-mono text-teal-600" title="Processing">
        [ <span className="font-mono">{summary.processing}</span> ⟳ ]
      </span>
    );
  }

  // Pending - shown if > 0, using ⚠️ symbol
  if (summary.pending > 0) {
    metrics.push(
      <span key="pending" className="font-mono text-amber-600" title="Pending">
        [ <span className="font-mono">{summary.pending}</span> ⚠️ ]
      </span>
    );
  }

  // Merged - shown if > 0, using ✓ symbol
  if (summary.merged > 0) {
    metrics.push(
      <span key="merged" className="font-mono text-gray-500" title="Merged">
        [ <span className="font-mono">{summary.merged}</span> ✓ ]
      </span>
    );
  }

  // Closed - shown if > 0, using ✗ symbol
  if (summary.closed > 0) {
    metrics.push(
      <span key="closed" className="font-mono text-red-600" title="Closed">
        [ <span className="font-mono">{summary.closed}</span> ✗ ]
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1 text-xs font-mono">
      {metrics.map((metric, index) => (
        <React.Fragment key={index}>
          {index > 0 && <span className="text-gray-400 mx-1">•</span>}
          {metric}
        </React.Fragment>
      ))}
    </div>
  );
};
