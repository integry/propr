import React from 'react';
import type { UsageMetricRecord } from '@propr/shared';

export interface UsageBadgeProps {
  /** Total tokens consumed */
  tokens?: number;
  /** Cost in USD */
  cost?: number;
  /** Structured usage metric records (one per metric key) */
  usageMetricRecords?: UsageMetricRecord[];
  /** Additional CSS classes */
  className?: string;
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
  usageMetricRecords,
  className = '',
}) => {
  const hasTokens = tokens != null && tokens > 0;
  const hasCost = cost != null && cost > 0;
  const hasRecords = usageMetricRecords != null && usageMetricRecords.length > 0;

  // Nothing to display
  if (!hasTokens && !hasCost && !hasRecords) {
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

  if (hasRecords) {
    for (const record of usageMetricRecords!) {
      const sign = record.metricValue > 0 ? '+' : '';
      parts.push(
        <span
          key={`${record.agent}-${record.metricKey}`}
          className={record.metricValue > 0 ? 'text-amber-600' : 'text-green-600'}
          title={`${record.metricKey}: ${sign}${record.metricValue.toFixed(1)}%`}
        >
          {record.metricKey} {sign}{record.metricValue.toFixed(1)}%
        </span>
      );
    }
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
