import React from 'react';
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
      // Quiet Success: no background, just gray text - recedes into background
      return 'text-gray-500';
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
      return '✓ Merged';
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
      // Quiet Success: no icon, checkmark is in the label
      return null;
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
    return null;
  }

  // Build metrics array for the Status Strip - using monospace code chip styling with bullet separators
  const metricItems: string[] = [];

  // Total issues - always shown
  metricItems.push(`${summary.total} Issues`);

  // Processing - shown if > 0, using ⟳ symbol
  if (summary.processing > 0) {
    metricItems.push(`${summary.processing} ⟳`);
  }

  // Pending - shown if > 0
  if (summary.pending > 0) {
    metricItems.push(`${summary.pending} pending`);
  }

  // Merged - shown if > 0, using ✓ symbol
  if (summary.merged > 0) {
    metricItems.push(`${summary.merged} ✓`);
  }

  // Closed - shown if > 0, using ✗ symbol
  if (summary.closed > 0) {
    metricItems.push(`${summary.closed} ✗`);
  }

  return metricItems;
};

/**
 * Renders the unified Status Strip combining issue metrics, status, and time
 * Format: "3 Issues  •  3 ✓  •  Merged  •  2 hours ago"
 */
export const renderStatusStrip = (
  summary: IssueSummary | null | undefined,
  effectiveStatus: string,
  updatedAt: string
): React.ReactNode => {
  const stripItems: string[] = [];

  // Add issue metrics if available
  const metrics = renderIssueSummary(summary);
  if (metrics && Array.isArray(metrics)) {
    stripItems.push(...metrics);
  }

  // Add status label
  stripItems.push(getStatusLabel(effectiveStatus));

  // Add relative time
  stripItems.push(formatRelativeTime(updatedAt));

  return (
    <span className="inline-flex items-center px-2 py-0.5 text-xs font-mono bg-slate-100 text-slate-600 rounded">
      {stripItems.join('  •  ')}
    </span>
  );
};
