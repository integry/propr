import React, { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { getAgentTankUsage, refreshAgentTank, AgentTankUsageResponse, AgentUsageData } from '../api/revertApi';
import { ProviderLogo } from './ui/ProviderLogo';
import { getModelDisplayName } from '../utils/modelDisplay';

// Refresh interval in milliseconds (60 seconds)
const REFRESH_INTERVAL = 60000;

// Visible provider labels keyed by Agent Tank provider key (presentation only).
// The underlying provider keys (e.g. "agy") are preserved for API payloads/lookups.
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  agy: 'Antigravity',
};

// Order providers appear in the status list. Codex must appear before Antigravity.
// Unknown providers retain their original relative order after these.
const PROVIDER_ORDER = ['claude', 'gemini', 'codex', 'agy'];

function getProviderRank(name: string): number {
  const idx = PROVIDER_ORDER.indexOf(name.toLowerCase());
  return idx === -1 ? PROVIDER_ORDER.length : idx;
}

// Map Antigravity thinking-level suffixes to compact bold badges.
const ANTIGRAVITY_LEVEL_BADGES: Record<string, string> = {
  medium: 'M',
  high: 'H',
  low: 'L',
};

// Shorten an Antigravity model name for display while keeping the full name for tooltips.
// `(Medium)` -> bold `M`, `(High)` -> bold `H`, `(Low)` -> bold `L`, `(Thinking)` removed.
function formatAntigravityModelLabel(fullName: string): { display: React.ReactNode; plain: string } {
  const withoutThinking = fullName.replace(/\s*\(Thinking\)/gi, '').trim();
  const levelMatch = withoutThinking.match(/\s*\((Medium|High|Low)\)/i);

  if (levelMatch) {
    const badge = ANTIGRAVITY_LEVEL_BADGES[levelMatch[1].toLowerCase()];
    const base = withoutThinking.replace(levelMatch[0], '').trim();
    return {
      display: (
        <>
          {base} <strong className="font-bold">{badge}</strong>
        </>
      ),
      plain: `${base} ${badge}`,
    };
  }

  return { display: withoutThinking, plain: withoutThinking };
}

// Get status color based on percentage
function getStatusColor(percent: number): string {
  if (percent <= 50) return 'bg-green-500';
  if (percent <= 80) return 'bg-yellow-500';
  return 'bg-red-500';
}

// Get text color based on percentage
function getTextColor(percent: number): string {
  if (percent <= 50) return 'text-green-600';
  if (percent <= 80) return 'text-yellow-600';
  return 'text-red-600';
}

interface UsageMetric {
  label: string;
  // Optional rich display (e.g. bold thinking-level badge). Falls back to `label`.
  displayLabel?: React.ReactNode;
  // Optional explicit tooltip text (e.g. full Antigravity model name).
  title?: string;
  percent: number;
  resetsIn?: string;
}

// Extract all usage metrics from agent data
function getAllMetrics(agent: AgentUsageData): UsageMetric[] {
  const metrics: UsageMetric[] = [];
  if (!agent.usage) return metrics;

  // Claude metrics
  if (agent.usage.session) {
    metrics.push({
      label: 'Session',
      percent: agent.usage.session.percent,
      resetsIn: agent.usage.session.resetsIn
    });
  }
  if (agent.usage.weeklyAll) {
    metrics.push({
      label: 'Weekly',
      percent: agent.usage.weeklyAll.percent,
      resetsIn: agent.usage.weeklyAll.resetsIn
    });
  }
  if (agent.usage.weeklySonnet) {
    metrics.push({
      label: 'Sonnet',
      percent: agent.usage.weeklySonnet.percent,
      resetsIn: agent.usage.weeklySonnet.resetsIn
    });
  }
  // Gemini / Antigravity models
  if (agent.usage.models) {
    const isAntigravity = agent.name.toLowerCase() === 'agy';
    for (const model of agent.usage.models) {
      if (isAntigravity) {
        // Keep the full model name (incl. "Gemini" prefix and thinking level) for the tooltip,
        // but shorten the visible label.
        const fullName = getModelDisplayName(model.model);
        const { display, plain } = formatAntigravityModelLabel(fullName);
        metrics.push({
          label: plain,
          displayLabel: display,
          title: fullName,
          percent: model.percentUsed,
          resetsIn: model.resetsIn
        });
      } else {
        metrics.push({
          label: getModelDisplayName(model.model, { compactGemini: true }),
          percent: model.percentUsed,
          resetsIn: model.resetsIn
        });
      }
    }
  }

  // Codex metrics - fiveHour (session) first, then weekly
  if (agent.usage.fiveHour) {
    metrics.push({
      label: 'Session',
      percent: agent.usage.fiveHour.percentUsed,
      resetsIn: agent.usage.fiveHour.resetsIn
    });
  }
  // Codex weekly uses percentUsed, not percent
  if (agent.usage.weekly && !agent.usage.weeklyAll) {
    const weeklyData = agent.usage.weekly as { percentUsed?: number; percent?: number; resetsIn?: string };
    metrics.push({
      label: 'Weekly',
      percent: weeklyData.percentUsed ?? weeklyData.percent ?? 0,
      resetsIn: weeklyData.resetsIn
    });
  }

  return metrics;
}

// Get primary metric for collapsed view
function getPrimaryMetric(agent: AgentUsageData): UsageMetric | null {
  const metrics = getAllMetrics(agent);
  return metrics.length > 0 ? metrics[0] : null;
}

interface MetricRowProps {
  metric: UsageMetric;
  compact?: boolean;
}

const MetricRow: React.FC<MetricRowProps> = ({ metric, compact = false }) => (
  <div className={`flex items-center justify-between ${compact ? 'py-0.5' : 'py-1'}`}>
    <span
      className="text-[10px] text-gray-500 truncate max-w-[100px]"
      title={metric.title ?? (metric.resetsIn ? `Resets in ${metric.resetsIn}` : metric.label)}
    >
      {metric.displayLabel ?? metric.label}
    </span>
    <div className="flex items-center gap-1.5">
      <div className={`${compact ? 'w-10' : 'w-12'} h-1.5 bg-gray-200 rounded-full overflow-hidden`}>
        <div
          className={`h-full rounded-full ${getStatusColor(metric.percent)}`}
          style={{ width: `${Math.min(100, metric.percent)}%` }}
        />
      </div>
      <span className={`text-[10px] font-medium w-7 text-right ${getTextColor(metric.percent)}`}>
        {metric.percent}%
      </span>
    </div>
  </div>
);

interface AgentRowProps {
  agent: AgentUsageData;
  expanded: boolean;
  onToggle: () => void;
}

const AgentRow: React.FC<AgentRowProps> = ({ agent, expanded, onToggle }) => {
  const metrics = getAllMetrics(agent);
  const primaryMetric = getPrimaryMetric(agent);
  const hasMultipleMetrics = metrics.length > 1;

  if (!primaryMetric && !agent.error) return null;

  const displayName = PROVIDER_DISPLAY_NAMES[agent.name.toLowerCase()]
    ?? (agent.name.charAt(0).toUpperCase() + agent.name.slice(1));

  return (
    <div className="py-1">
      <div
        className={`flex items-center justify-between ${hasMultipleMetrics ? 'cursor-pointer hover:bg-gray-50 -mx-1 px-1 rounded' : ''}`}
        onClick={hasMultipleMetrics ? onToggle : undefined}
      >
        <div className="flex items-center gap-1.5 text-gray-600">
          {hasMultipleMetrics && (
            expanded ? <ChevronDown className="w-3 h-3 text-gray-400" /> : <ChevronRight className="w-3 h-3 text-gray-400" />
          )}
          <ProviderLogo provider={agent.name} className="w-3.5 h-3.5" />
          <span className="text-xs">{displayName}</span>
        </div>
        {agent.error ? (
          <span className="text-[10px] text-red-500">Error</span>
        ) : primaryMetric && !expanded ? (
          <div className="flex items-center gap-1.5">
            <div className="w-10 h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${getStatusColor(primaryMetric.percent)}`}
                style={{ width: `${Math.min(100, primaryMetric.percent)}%` }}
              />
            </div>
            <span className={`text-[10px] font-medium w-7 text-right ${getTextColor(primaryMetric.percent)}`}>
              {primaryMetric.percent}%
            </span>
          </div>
        ) : null}
      </div>

      {/* Expanded details */}
      {expanded && metrics.length > 0 && (
        <div className="ml-5 mt-1 space-y-0.5 border-l border-gray-200 pl-2">
          {metrics.map((metric, idx) => (
            <MetricRow key={idx} metric={metric} compact />
          ))}
        </div>
      )}
    </div>
  );
};

const AgentTankSidebar: React.FC = () => {
  const [data, setData] = useState<AgentTankUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

  const fetchUsage = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    try {
      // Trigger Agent Tank to fetch fresh data from providers
      if (isManualRefresh) {
        await refreshAgentTank();
      }
      const result = await getAgentTankUsage();
      setData(result);
    } catch (err) {
      console.error('Failed to fetch Agent Tank usage:', err);
      setData({ enabled: false });
    } finally {
      setLoading(false);
      if (isManualRefresh) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage(false);
    const interval = setInterval(() => fetchUsage(false), REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchUsage]);

  const toggleAgent = useCallback((agentName: string) => {
    setExpandedAgents(prev => {
      const next = new Set(prev);
      if (next.has(agentName)) {
        next.delete(agentName);
      } else {
        next.add(agentName);
      }
      return next;
    });
  }, []);

  // Don't render if disabled or loading
  if (loading) return null;
  if (!data?.enabled) return null;
  if (!data.agents || Object.keys(data.agents).length === 0) return null;

  const agents = Object.values(data.agents)
    .filter(a => a.usage || a.error)
    .sort((a, b) => getProviderRank(a.name) - getProviderRank(b.name));
  if (agents.length === 0) return null;

  return (
    <div className="px-4 py-3 border-t border-gray-200">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          Usage
        </span>
        <button
          onClick={() => fetchUsage(true)}
          disabled={refreshing}
          className="text-gray-400 hover:text-primary-600 disabled:opacity-50"
          title="Refresh usage"
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="space-y-0">
        {agents.map(agent => (
          <AgentRow
            key={agent.name}
            agent={agent}
            expanded={expandedAgents.has(agent.name)}
            onToggle={() => toggleAgent(agent.name)}
          />
        ))}
      </div>
    </div>
  );
};

export default AgentTankSidebar;
