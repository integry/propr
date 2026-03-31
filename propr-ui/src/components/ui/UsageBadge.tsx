import React from 'react';
import type { UsageMetrics } from '@propr/shared';

export interface UsageBadgeProps {
  /** Total tokens consumed */
  tokens?: number;
  /** Cost in USD */
  cost?: number;
  /** Usage metrics object (delta.providerDetails may contain percentage info) */
  usageMetrics?: UsageMetrics;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Extracts the primary percentage delta from a nested usage metrics object.
 * Walks providerDetails looking for the first numeric "percent" field.
 */
function extractPercentDelta(metrics: UsageMetrics): number | null {
  const details = metrics.delta?.providerDetails;
  if (!details) return null;

  // Search one level deep for a "percent" key
  for (const value of Object.values(details)) {
    if (typeof value === 'number' && Object.keys(details).some(
      k => k.toLowerCase().includes('percent')
    )) {
      // Direct percent value at top level
      const percentKey = Object.keys(details).find(k => k.toLowerCase().includes('percent'));
      if (percentKey && typeof details[percentKey] === 'number') {
        return details[percentKey] as number;
      }
    }
    // Nested object with a percent field
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      for (const [nestedKey, nestedVal] of Object.entries(nested)) {
        if (nestedKey.toLowerCase().includes('percent') && typeof nestedVal === 'number') {
          return nestedVal;
        }
      }
    }
  }

  return null;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return tokens.toLocaleString();
}

function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
}

export const UsageBadge: React.FC<UsageBadgeProps> = ({
  tokens,
  cost,
  usageMetrics,
  className = '',
}) => {
  const percentDelta = usageMetrics ? extractPercentDelta(usageMetrics) : null;

  const hasTokens = tokens != null && tokens > 0;
  const hasCost = cost != null && cost > 0;
  const hasPercent = percentDelta != null;

  // Nothing to display
  if (!hasTokens && !hasCost && !hasPercent) {
    return null;
  }

  const parts: React.ReactNode[] = [];

  if (hasTokens) {
    parts.push(
      <span key="tokens" title={`${tokens!.toLocaleString()} tokens`}>
        {formatTokens(tokens!)} tok
      </span>
    );
  }

  if (hasCost) {
    parts.push(
      <span key="cost" title={`$${cost!.toFixed(4)} USD`}>
        {formatCost(cost!)}
      </span>
    );
  }

  if (hasPercent) {
    const sign = percentDelta! > 0 ? '+' : '';
    parts.push(
      <span
        key="percent"
        className={percentDelta! > 0 ? 'text-amber-600' : 'text-green-600'}
        title={`${sign}${percentDelta!.toFixed(1)}% usage delta`}
      >
        {sign}{percentDelta!.toFixed(1)}%
      </span>
    );
  }

  return (
    <code
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 bg-slate-100 text-slate-600 text-xs font-mono rounded-md border border-slate-200 ${className}`}
    >
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-slate-300">|</span>}
          {part}
        </React.Fragment>
      ))}
    </code>
  );
};

export default UsageBadge;
