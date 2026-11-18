import React from 'react';
import type { UsageMetricRecord } from '@propr/shared';
import { humanizeMetricKey } from '../../utils/usageMetricLabels';

export interface UsageBadgeProps {
  /** Total billable tokens consumed, including cached input */
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
      <span key="tokens" title={`${tokens!.toLocaleString()} billable tokens (input, output, and cache)`}>
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
      // Skip 0% metrics — nothing consumed
      if (record.metricValue === 0) continue;
      const sign = record.metricValue > 0 ? '+' : '';
      parts.push(
        <span
          key={`${record.agent}-${record.metricKey}`}
          title={`${humanizeMetricKey(record.metricKey)}: ${sign}${record.metricValue.toFixed(1)}%`}
        >
          <span className="text-slate-500">{humanizeMetricKey(record.metricKey)}</span>{' '}
          <span className={record.metricValue > 0 ? 'text-amber-600' : 'text-green-600'}>
            {sign}{record.metricValue.toFixed(1)}%
          </span>
        </span>
      );
    }
  }

  // Each part is a whole flex item; the separator is the item's left border,
  // not a text character. The list is pulled 1px left under the badge's clipped
  // edge, so the part that starts a line (the first, or one that wrapped) has
  // its border hidden: no line ever starts or ends with a separator.
  return (
    <code
      data-testid="usage-badge"
      className={`inline-flex max-w-full overflow-hidden py-0.5 bg-slate-100 text-slate-600 text-xs font-mono rounded-md border border-slate-200 ${className}`}
    >
      <span className="-ml-px flex min-w-0 flex-wrap items-center gap-y-0.5">
        {parts.map((part, i) => (
          <span
            key={i}
            data-testid="usage-badge-part"
            className="min-w-0 max-w-full truncate whitespace-nowrap border-l border-slate-300 px-1.5"
          >
            {part}
          </span>
        ))}
      </span>
    </code>
  );
};

export default UsageBadge;
