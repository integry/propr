import React, { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Gauge, RefreshCw } from 'lucide-react';
import { getAgentTankUsage, refreshAgentTank, AgentTankUsageResponse, AgentUsageData } from '../api/revertApi';
import { ProviderLogo } from './ui/ProviderLogo';
import {
  getAllMetrics,
  getPrimaryMetric,
  getMetricTooltip,
  getProviderDisplayName,
  getProviderRank,
  getStatusColor,
  getTextColor,
  type UsageMetric,
} from './agentTankMetrics';
import { SIDEBAR_ICON_STROKE_WIDTH, SIDEBAR_ICON_STROKE_CLASS } from './icons/sidebarIconStroke';
import { useLiveResource } from '../hooks/useLiveResource';

// Which provider rows are expanded is a preference, not session state: someone
// watching Claude's weekly quotas wants the same rows open after a reload.
export const EXPANDED_AGENTS_STORAGE_KEY = 'agent-tank-expanded-agents';

// Storage access throws in private browsing, sandboxed iframes and non-browser
// renderers, and the stored value can be anything a previous version (or a
// user) left behind — so both directions fall back to the default expansion
// rather than taking the widget down with them. `null` means no preference has
// been saved yet, which is what lets the default differ by layout.
function loadExpandedAgents(): Set<string> | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const stored = window.localStorage.getItem(EXPANDED_AGENTS_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((name): name is string => typeof name === 'string'));
  } catch {
    return null;
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

// Until someone toggles a provider, a lone provider starts open (there is
// nothing else to scan past), and so does every provider on a surface opened
// only to read the numbers (the mobile Usage sheet). Once a preference is
// saved it is shared with the sidebar.
function defaultExpansion(agents: AgentUsageData[], expandAll: boolean): Set<string> {
  return expandAll || agents.length === 1
    ? new Set(agents.map(agent => agent.name))
    : new Set();
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

export const AgentRow: React.FC<AgentRowProps> = ({ agent, expanded, onToggle }) => {
  const metrics = getAllMetrics(agent);
  const primaryMetric = getPrimaryMetric(agent);
  // Every provider with usage data is the same kind of node — an accordion
  // parent whose children are its metric rows — so every one of them gets a
  // chevron, even with a single child. A provider must never look like a
  // parent yet lack the parent's affordance. Only error-only rows (which
  // render a status instead of data) are inert.
  const expandable = metrics.length > 0;
  // Grouped metrics get a sub-header row each time their pool changes; their
  // rows are indented one step under it.
  const children: Array<{ group?: string; metric?: UsageMetric }> = [];
  metrics.forEach((metric, idx) => {
    if (metric.group && metric.group !== metrics[idx - 1]?.group) {
      children.push({ group: metric.group });
    }
    children.push({ metric });
  });

  if (!primaryMetric && !agent.error) return null;

  const displayName = getProviderDisplayName(agent.name);

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
          {children.map((child, idx) => (
            <div key={idx} className={`relative min-w-0 ${child.metric?.group ? 'pl-[41px]' : 'pl-[33px]'}`}>
              <span
                aria-hidden="true"
                className={`absolute left-0 top-0 w-px bg-gray-200 ${
                  idx === children.length - 1 ? 'h-1/2' : 'bottom-0'
                }`}
              />
              {child.metric ? (
                <MetricRow metric={child.metric} compact />
              ) : (
                <div className="flex h-5 min-w-0 items-center">
                  <span className="min-w-0 truncate text-[10px] font-medium text-gray-600" title={child.group}>
                    {child.group}
                  </span>
                </div>
              )}
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
  // `summary` folds the widget into one drill-down row ("Claude 25% · Codex 7%")
  // that calls `onOpenDetails` — for menus, where a block of progress bars
  // would push every entry below it off screen.
  layout?: 'panel' | 'summary';
  onOpenDetails?: () => void;
  // Open every provider until a preference is saved.
  expandAll?: boolean;
}

const AgentTankSidebar: React.FC<AgentTankSidebarProps> = ({
  allowManualRefresh = true,
  className = '',
  scrollable = false,
  layout = 'panel',
  onOpenDetails,
  expandAll = false,
}) => {
  const [refreshing, setRefreshing] = useState(false);
  const [savedExpansion, setSavedExpansion] = useState<Set<string> | null>(() => loadExpandedAgents());

  const { data: usage, error: usageError, isLoading: loading, refreshNow } = useLiveResource<AgentTankUsageResponse>({
    read: signal => getAgentTankUsage({ signal }),
    scopeKey: 'agent-tank-usage',
    snapshotResource: 'usage',
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


  // Don't render if disabled or loading
  if (loading) return null;
  if (!data?.enabled) return null;
  if (!data.agents || Object.keys(data.agents).length === 0) return null;

  const agents = Object.values(data.agents)
    .filter(a => a.usage || a.error)
    .sort((a, b) => getProviderRank(a.name) - getProviderRank(b.name));
  if (agents.length === 0) return null;

  const expandedAgents = savedExpansion ?? defaultExpansion(agents, expandAll);
  const toggleAgent = (agentName: string) => {
    const next = new Set(expandedAgents);
    if (next.has(agentName)) {
      next.delete(agentName);
    } else {
      next.add(agentName);
    }
    saveExpandedAgents(next);
    setSavedExpansion(next);
  };

  const refreshButton = allowManualRefresh && (
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
  );
  const agentRows = agents.map(agent => (
    <AgentRow
      key={agent.name}
      agent={agent}
      expanded={expandedAgents.has(agent.name)}
      onToggle={() => toggleAgent(agent.name)}
    />
  ));

  if (layout === 'summary') {
    const summary = agents.flatMap(agent => {
      const metric = getPrimaryMetric(agent);
      return metric ? [{ name: getProviderDisplayName(agent.name), percent: metric.percent }] : [];
    });
    return (
      <button
        type="button"
        onClick={onOpenDetails}
        aria-haspopup="dialog"
        className={`flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 ${className}`}
      >
        <Gauge className="h-5 w-5 flex-none text-slate-500" aria-hidden="true" />
        <span className="flex-none font-medium">API &amp; quota usage</span>
        <span className="ml-auto min-w-0 truncate text-right text-xs font-medium text-slate-500" data-testid="usage-summary">
          {summary.map((item, index) => (
            <React.Fragment key={item.name}>
              {index > 0 && <span className="text-slate-300" aria-hidden="true"> · </span>}
              {item.name} <span className={getTextColor(item.percent)}>{item.percent}%</span>
            </React.Fragment>
          ))}
        </span>
        <ChevronRight className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
      </button>
    );
  }

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
        {refreshButton}
      </div>
      <div className={scrollable
        ? 'agent-tank-scrollport max-h-56 min-w-0 max-w-full overflow-x-hidden overflow-y-auto'
        : 'agent-tank-scrollport min-w-0 max-w-full space-y-0'}>
        {agentRows}
      </div>
    </div>
  );
};

export { AgentTankSidebar as AgentTankUsage };
export default AgentTankSidebar;
