import React, { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { getAgentTankUsage, refreshAgentTank, AgentTankUsageResponse, AgentUsageData } from '../api/revertApi';
import { ProviderLogo } from './ui/ProviderLogo';
import { getModelDisplayName } from '../utils/modelDisplay';
import { SIDEBAR_ICON_STROKE_WIDTH, SIDEBAR_ICON_STROKE_CLASS } from './icons/sidebarIconStroke';
import { useLiveResource } from '../hooks/useLiveResource';

// Which provider rows are expanded is a preference, not session state: someone
// watching Claude's weekly quotas wants the same rows open after a reload.
export const EXPANDED_AGENTS_STORAGE_KEY = 'agent-tank-expanded-agents';

// Storage access throws in private browsing, sandboxed iframes and non-browser
// renderers, and the stored value can be anything a previous version (or a
// user) left behind — so both directions fall back to the collapsed default
// rather than taking the widget down with them.
function loadExpandedAgents(): Set<string> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return new Set();
    const stored = window.localStorage.getItem(EXPANDED_AGENTS_STORAGE_KEY);
    if (!stored) return new Set();
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((name): name is string => typeof name === 'string'));
  } catch {
    return new Set();
  }
}

function saveExpandedAgents(expanded: Set<string>): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(EXPANDED_AGENTS_STORAGE_KEY, JSON.stringify([...expanded]));
  } catch {
    // Persistence is a convenience; a storage failure must not break toggling.
  }
}

// Visible provider labels keyed by ProPR-facing provider key.
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  antigravity: 'Antigravity',
};

// Order providers appear in the status list. Codex must appear before Antigravity.
// Unknown providers retain their original relative order after these.
const PROVIDER_ORDER = ['claude', 'gemini', 'codex', 'antigravity'];

function getProviderRank(name: string): number {
  const idx = PROVIDER_ORDER.indexOf(name.toLowerCase());
  return idx === -1 ? PROVIDER_ORDER.length : idx;
}

// Agent Tank reports Antigravity quotas as "<group> · <window> Limit Remaining".
// Every row in the widget already reads as remaining capacity, so the trailing
// word is noise that pushes the informative part out of the truncated label.
function stripRemainingSuffix(name: string): string {
  return name.replace(/\s+Remaining$/i, '').trim();
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

// Quota consumed past half the budget is worth noticing, past four fifths is
// worth acting on.
const USAGE_WARNING_PERCENT = 50;
const USAGE_CRITICAL_PERCENT = 80;

// Capacity bars stay neutral for light usage; past the thresholds they take on
// pastel orange then pastel red. The tints are deliberately soft — the sidebar
// reports a level, it does not raise an alarm — but still separate clearly from
// the gray-200 track behind them.
function getStatusColor(percent: number): string {
  if (percent > USAGE_CRITICAL_PERCENT) return 'bg-red-400';
  if (percent > USAGE_WARNING_PERCENT) return 'bg-orange-300';
  return 'bg-slate-400';
}

// Text follows the same thresholds as the bar, but at a darker step: these are
// 10px numerals, so they need readable contrast rather than the bar's pastel.
function getTextColor(percent: number): string {
  if (percent > USAGE_CRITICAL_PERCENT) return 'text-red-600';
  if (percent > USAGE_WARNING_PERCENT) return 'text-orange-600';
  return 'text-gray-500';
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
  if (agent.usage.weeklyFable) {
    metrics.push({
      label: 'Fable',
      percent: agent.usage.weeklyFable.percent,
      resetsIn: agent.usage.weeklyFable.resetsIn
    });
  }
  // Gemini / Antigravity models
  if (agent.usage.models) {
    const isAntigravity = agent.name.toLowerCase() === 'antigravity';
    for (const model of agent.usage.models) {
      if (isAntigravity) {
        // Keep the full model name (incl. "Gemini" prefix and thinking level) for the tooltip,
        // but shorten the visible label.
        const fullName = stripRemainingSuffix(getModelDisplayName(model.model));
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
          label: stripRemainingSuffix(getModelDisplayName(model.model, { compactGemini: true })),
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

// Rows with an explicit tooltip (Antigravity, whose visible label is shortened)
// must still report their reset countdown — the same "Resets in ..." suffix every
// other provider's rows get — so the two are composed rather than one replacing
// the other. Agent Tank omits the countdown for quotas it has no window for.
function getMetricTooltip(metric: UsageMetric): string {
  const resets = metric.resetsIn ? `Resets in ${metric.resetsIn}` : null;
  if (metric.title) return resets ? `${metric.title} · ${resets}` : metric.title;
  return resets ?? metric.label;
}

interface MetricRowProps {
  metric: UsageMetric;
  compact?: boolean;
}

// Compact rows (the expanded tree children) use a fixed 20px height rather
// than padding so every child of the threading rail has a known center line.
//
// Capacity tracks are a shared w-14 (56px) everywhere so equal percentages
// paint equal pixels across rows. The fill's width is pure math from the
// datum (`${percent}%` of the track); only the track's outer pill is rounded —
// the fill itself is a clipped rectangle, because rounding a few-px-wide fill
// into its own pill would erase the visible difference between single-digit
// values (at 56px, 8% / 12% / 17% must resolve as 4.5 / 6.7 / 9.5px).
const MetricRow: React.FC<MetricRowProps> = ({ metric, compact = false }) => (
  <div className={`flex min-w-0 items-center gap-2 ${compact ? 'h-5' : 'py-1'}`}>
    <span
      className="min-w-0 max-w-[100px] flex-1 truncate text-[10px] text-gray-500"
      title={getMetricTooltip(metric)}
    >
      {metric.displayLabel ?? metric.label}
    </span>
    <div className="flex flex-none items-center gap-1">
      <div className="h-1.5 w-14 flex-none overflow-hidden rounded-full bg-gray-200">
        <div
          className={`h-full ${getStatusColor(metric.percent)}`}
          style={{ width: `${Math.min(100, metric.percent)}%` }}
        />
      </div>
      <span className={`text-[10px] font-medium leading-none w-7 text-right ${getTextColor(metric.percent)}`}>
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
  // Every provider with usage data is the same kind of node — an accordion
  // parent whose children are its metric rows — so every one of them gets a
  // chevron, even with a single child. A provider must never look like a
  // parent yet lack the parent's affordance. Only error-only rows (which
  // render a status instead of data) are inert.
  const expandable = metrics.length > 0;

  if (!primaryMetric && !agent.error) return null;

  const displayName = PROVIDER_DISPLAY_NAMES[agent.name.toLowerCase()]
    ?? (agent.name.charAt(0).toUpperCase() + agent.name.slice(1));

  return (
    <div className="min-w-0 py-1">
      <div
        className={`flex min-w-0 items-center gap-1 ${expandable ? 'cursor-pointer rounded hover:bg-slate-900/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-slate-400' : ''}`}
        onClick={expandable ? onToggle : undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? expanded : undefined}
        onKeyDown={expandable ? event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        } : undefined}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-gray-600">
          {/* Fixed-size chevron slot keeps provider icons and labels on the same
              vertical axis; error-only rows leave the slot empty. */}
          <span className="flex h-3.5 w-3.5 flex-none items-center justify-center">
            {expandable && (
              expanded
                ? <ChevronDown className={`${SIDEBAR_ICON_STROKE_CLASS} w-3 h-3 text-gray-400`} strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} />
                : <ChevronRight className={`${SIDEBAR_ICON_STROKE_CLASS} w-3 h-3 text-gray-400`} strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} />
            )}
          </span>
          <ProviderLogo provider={agent.name} className="w-3.5 h-3.5 flex-none" />
          <span className="min-w-0 truncate text-xs leading-none" title={displayName}>{displayName}</span>
        </div>
        {/* leading-none keeps the right-hand text boxes shorter than the 14px icon
            slot on the left, so the row height stays an even 14px and the chevron,
            provider icon, and label center on whole pixels. */}
        {agent.error ? (
          <span className="flex-none text-[10px] leading-none text-red-500">Error</span>
        ) : primaryMetric && !expanded ? (
          <div className="flex flex-none items-center gap-1">
            {/* Same w-14 track and rectangular fill as MetricRow so a given
                percentage paints the same pixels in every row. */}
            <div className="h-1.5 w-14 flex-none overflow-hidden rounded-full bg-gray-200">
              <div
                className={`h-full ${getStatusColor(primaryMetric.percent)}`}
                style={{ width: `${Math.min(100, primaryMetric.percent)}%` }}
              />
            </div>
            <span className={`text-[10px] font-medium leading-none w-7 text-right ${getTextColor(primaryMetric.percent)}`}>
              {primaryMetric.percent}%
            </span>
          </div>
        ) : null}
      </div>

      {/* Expanded details. The threading rail is drawn as one segment per
          child, each anchored to its own relative row: full-height (top-0
          bottom-0) for every child except the last, whose segment is h-1/2
          (top half only). The segments abut into one continuous line that
          terminates at exactly the vertical center of the final child — by
          construction, independent of row count or row height, so it can
          neither stop short nor overshoot into the space below. The rail
          stays centered under the 14px chevron slot (7px), while the metric
          text is padded to 33px so it lands on the 40px axis of the parent
          label (chevron 14 + gap 6 + icon 14 + gap 6), matching standard
          tree-view text-under-text alignment. */}
      {expanded && metrics.length > 0 && (
        <div className="ml-[7px] mt-0.5 min-w-0">
          {metrics.map((metric, idx) => (
            <div key={idx} className="relative min-w-0 pl-[33px]">
              <span
                aria-hidden="true"
                className={`absolute left-0 top-0 w-px bg-gray-200 ${
                  idx === metrics.length - 1 ? 'h-1/2' : 'bottom-0'
                }`}
              />
              <MetricRow metric={metric} compact />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface AgentTankSidebarProps {
  allowManualRefresh?: boolean;
  className?: string;
  scrollable?: boolean;
}

const AgentTankSidebar: React.FC<AgentTankSidebarProps> = ({ allowManualRefresh = true, className = '', scrollable = false }) => {
  const [refreshing, setRefreshing] = useState(false);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => loadExpandedAgents());

  /*
    Usage is re-read when the server says a quota moved.

    `usage:update` is a bare trigger rather than a snapshot on purpose: the
    usage endpoint owns the projection and its permission check, so pushing the
    numbers would mean authorizing them in two places. The read is the same one
    as before - it just no longer happens on a timer.
  */
  const { data: usage, error: usageError, isLoading: loading, refreshNow } = useLiveResource<AgentTankUsageResponse>({
    read: signal => getAgentTankUsage({ signal }),
    scopeKey: 'agent-tank-usage',
    interest: { usage: true },
  });
  // A failed read keeps the last good numbers; with nothing read yet the widget
  // stays out of the sidebar rather than showing an empty frame.
  const data = usage ?? (usageError ? { enabled: false } : null);

  const handleManualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // The button asks the backend to re-probe the providers; the immediate
      // read keeps it responsive instead of waiting for the published event.
      await refreshAgentTank();
      await refreshNow();
    } catch (err) {
      console.error('Failed to refresh Agent Tank usage:', err);
    } finally {
      setRefreshing(false);
    }
  }, [refreshNow]);

  const toggleAgent = useCallback((agentName: string) => {
    setExpandedAgents(prev => {
      const next = new Set(prev);
      if (next.has(agentName)) {
        next.delete(agentName);
      } else {
        next.add(agentName);
      }
      saveExpandedAgents(next);
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
    // In the sidebar, zone boundaries are whitespace, not rules: the utility
    // group's mt-auto (in Layout) absorbs the flexible space above, so the
    // widget draws no divider of its own. Surfaces that still want a rule
    // (e.g. the mobile sheet) pass border classes via className.
    <div className={`px-4 pt-4 pb-3 ${className}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase font-bold tracking-wider text-slate-400">
          Usage
        </span>
        {allowManualRefresh && (
          <button
            type="button"
            onClick={() => { void handleManualRefresh(); }}
            disabled={refreshing}
            className="-my-1 -mr-1 rounded p-1 text-slate-400 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400 disabled:opacity-50"
            title="Refresh usage"
            aria-label="Refresh usage"
          >
            <RefreshCw className={`${SIDEBAR_ICON_STROKE_CLASS} w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} strokeWidth={SIDEBAR_ICON_STROKE_WIDTH} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className={scrollable
        ? 'agent-tank-scrollport max-h-56 min-w-0 max-w-full overflow-x-hidden overflow-y-auto'
        : 'agent-tank-scrollport min-w-0 max-w-full space-y-0'}>
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

export { AgentTankSidebar as AgentTankUsage };
export default AgentTankSidebar;
