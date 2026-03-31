import React, { useMemo } from 'react';
import type { UsageMetricRecord } from '@propr/shared';
import { UsageBadge } from '../ui/UsageBadge';
import { TokenUsage } from './types';

export interface RealTimeStatsProps {
  /** Aggregated token usage across all agent loop turns */
  tokenUsage?: TokenUsage;
  /** Total cost in USD for the task */
  costUsd?: number;
  /** Percentage of allowance consumed (0-100) */
  allowancePercent?: number;
}

const RealTimeStats: React.FC<RealTimeStatsProps> = ({ tokenUsage, costUsd, allowancePercent }) => {
  const totalTokens = useMemo(() => {
    if (!tokenUsage) return undefined;
    const input = (tokenUsage.input_tokens ?? 0) +
      (tokenUsage.cache_creation_input_tokens ?? 0) +
      (tokenUsage.cache_read_input_tokens ?? 0);
    const output = tokenUsage.output_tokens ?? 0;
    const total = input + output;
    return total > 0 ? total : undefined;
  }, [tokenUsage]);

  const usageMetricRecords = useMemo<UsageMetricRecord[] | undefined>(() => {
    if (allowancePercent == null) return undefined;

    return [{
      agent: 'task',
      metricKey: 'allowance',
      metricValue: allowancePercent,
    }];
  }, [allowancePercent]);

  const hasData = totalTokens != null || (costUsd != null && costUsd > 0) || allowancePercent != null;

  if (!hasData) {
    return null;
  }

  return (
    <UsageBadge
      tokens={totalTokens}
      cost={costUsd}
      usageMetricRecords={usageMetricRecords}
    />
  );
};

export default RealTimeStats;
