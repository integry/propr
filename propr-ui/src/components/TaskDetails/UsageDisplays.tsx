import React from 'react';
import { Zap } from 'lucide-react';
import { TokenUsage, UsageMetricRecord } from './types';

// Format token count for display (e.g., 1234 -> "1.2k", 1234567 -> "1.2M")
const formatTokenCount = (count: number | null | undefined): string => {
  if (count === null || count === undefined) return '-';
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
};

// Vertical divider component for consistent styling
const Divider: React.FC = () => (
  <div className="h-4 w-px bg-gray-300 hidden sm:block" />
);

// Token usage display component
export const TokenUsageDisplay: React.FC<{ tokenUsage: TokenUsage | undefined }> = ({ tokenUsage }) => {
  if (!tokenUsage) return null;

  const inputTokens = (tokenUsage.input_tokens ?? 0) +
                      (tokenUsage.cache_creation_input_tokens ?? 0) +
                      (tokenUsage.cache_read_input_tokens ?? 0);
  const outputTokens = tokenUsage.output_tokens ?? 0;

  if (inputTokens === 0 && outputTokens === 0) return null;

  return (
    <>
      <Divider />
      <span
        className="flex items-center gap-1.5 bg-amber-50 text-amber-700 px-2 py-0.5 rounded text-xs font-medium border border-amber-100 cursor-default"
        title={`Input: ${tokenUsage.input_tokens ?? 0} | Output: ${tokenUsage.output_tokens ?? 0}${tokenUsage.cache_read_input_tokens ? ` | Cache Read: ${tokenUsage.cache_read_input_tokens}` : ''}${tokenUsage.cache_creation_input_tokens ? ` | Cache Creation: ${tokenUsage.cache_creation_input_tokens}` : ''}`}
      >
        <Zap size={12} />
        In: {formatTokenCount(inputTokens)} | Out: {formatTokenCount(outputTokens)}
      </span>
    </>
  );
};

// Map of raw Agent Tank metric keys to human-readable labels
const METRIC_KEY_LABELS: Record<string, string> = {
  session: 'Session', weeklyAll: 'Weekly', weeklySonnet: 'Sonnet',
  weeklyOpus: 'Opus', weeklyHaiku: 'Haiku', fiveHour: 'Five Hour',
  weekly: 'Weekly', daily: 'Daily', monthly: 'Monthly',
};

function humanizeMetricKey(key: string): string {
  if (METRIC_KEY_LABELS[key]) return METRIC_KEY_LABELS[key];
  if (/^[A-Z]/.test(key)) return key;
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

function findMetricRecord(records: UsageMetricRecord[], rawKey: string): UsageMetricRecord | undefined {
  const humanized = METRIC_KEY_LABELS[rawKey] || rawKey;
  return records.find(r => r.metricKey === rawKey || r.metricKey === humanized);
}

// Usage metrics display component (Agent Tank tracking)
export const UsageMetricsDisplay: React.FC<{ usageMetricRecords: UsageMetricRecord[] | undefined }> = ({ usageMetricRecords }) => {
  if (!usageMetricRecords || usageMetricRecords.length === 0) return null;

  const sessionRecord = findMetricRecord(usageMetricRecords, 'session');
  const weeklyRecord = findMetricRecord(usageMetricRecords, 'weeklyAll');

  if (!sessionRecord && !weeklyRecord) return null;

  const sessionPct = sessionRecord?.metricValue ?? 0;
  const weeklyPct = weeklyRecord?.metricValue ?? 0;

  const tooltip = usageMetricRecords
    .map(r => `${humanizeMetricKey(r.metricKey)}: ${r.metricValue.toFixed(1)}%`)
    .join(' | ');

  return (
    <>
      <Divider />
      <span
        className="flex items-center gap-1.5 bg-blue-50 text-blue-700 px-2 py-0.5 rounded text-xs font-medium border border-blue-100 cursor-default"
        title={`Usage consumed: ${tooltip}`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20v-6M6 20V10M18 20V4" />
        </svg>
        {sessionPct > 0 ? `${sessionPct.toFixed(1)}% Session` : ''}
        {sessionPct > 0 && weeklyPct > 0 ? ' · ' : ''}
        {weeklyPct > 0 ? `${weeklyPct.toFixed(1)}% Weekly` : ''}
      </span>
    </>
  );
};
