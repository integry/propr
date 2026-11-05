import React from 'react';
import type { AgentUsageData } from '../api/revertApi';
import { getModelDisplayName } from '../utils/modelDisplay';
import { stripRemainingSuffix } from '../utils/usageMetricLabels';

// Visible provider labels keyed by ProPR-facing provider key.
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  antigravity: 'Antigravity',
};

// Order providers appear in the status list. Codex must appear before Antigravity.
// Unknown providers retain their original relative order after these.
const PROVIDER_ORDER = ['claude', 'gemini', 'codex', 'antigravity'];

export function getProviderDisplayName(name: string): string {
  return PROVIDER_DISPLAY_NAMES[name.toLowerCase()] ?? (name.charAt(0).toUpperCase() + name.slice(1));
}

export function getProviderRank(name: string): number {
  const idx = PROVIDER_ORDER.indexOf(name.toLowerCase());
  return idx === -1 ? PROVIDER_ORDER.length : idx;
}

// Antigravity quota windows arrive as "<pool> · <window> Limit" (after the
// "Remaining" suffix is stripped). At the sidebar's label width the pool name
// alone fills the row, so "Claude and GPT · Weekly Limit" and "Claude and GPT ·
// Five Hour Limit" both truncated to "Claude and …". The pool becomes a
// sub-header over its windows instead, and each row names only its window —
// as short as Claude's and Codex's "Session" / "Weekly". The full name stays in
// the tooltip.
const ANTIGRAVITY_WINDOW_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  'five hour': '5h',
};

function parseAntigravityQuotaWindow(fullName: string): { group: string; label: string } | null {
  const match = fullName.match(/^(.+?)\s*·\s*(.+?)\s+Limit$/i);
  if (!match) return null;
  const windowName = match[2].trim();
  return {
    group: match[1].trim(),
    label: ANTIGRAVITY_WINDOW_LABELS[windowName.toLowerCase()] ?? windowName,
  };
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
export function getStatusColor(percent: number): string {
  if (percent > USAGE_CRITICAL_PERCENT) return 'bg-red-400';
  if (percent > USAGE_WARNING_PERCENT) return 'bg-orange-300';
  return 'bg-slate-400';
}

// Text follows the same thresholds as the bar, but at a darker step: these are
// 10px numerals, so they need readable contrast rather than the bar's pastel.
export function getTextColor(percent: number): string {
  if (percent > USAGE_CRITICAL_PERCENT) return 'text-red-600';
  if (percent > USAGE_WARNING_PERCENT) return 'text-orange-600';
  return 'text-gray-500';
}

export interface UsageMetric {
  label: string;
  // Optional rich display (e.g. bold thinking-level badge). Falls back to `label`.
  displayLabel?: React.ReactNode;
  // Optional explicit tooltip text (e.g. full Antigravity model name).
  title?: string;
  // Optional pool the metric belongs to (e.g. Antigravity's "Claude and GPT"),
  // rendered as a sub-header above its consecutive rows.
  group?: string;
  percent: number;
  resetsIn?: string;
  // Agent Tank history series key (`session`, `weeklyAll`, `fiveHour`,
  // `model:<quota>`), so the row can look up its own usage line.
  historyKey?: string;
  // Quota cycle (`session`, `five_hour`, `weekly`, `daily`), which sets how
  // long one period of that line is.
  cycle?: string;
}

// Antigravity reports its cycles under CLI names; history uses window types.
const ANTIGRAVITY_CYCLES: Record<string, string> = {
  weekly: 'weekly',
  fiveHour: 'five_hour',
  sessionAgy: 'session',
  daily: 'daily',
};

const ANTIGRAVITY_CYCLE_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  fiveHour: '5h',
};

// A grouped Antigravity quota names its pool explicitly. Agent Tank qualifies a
// shared limit as "<pool> · Weekly Limit", but a pool tracked on its own - the
// separate Gemini 4 Argon quota - arrives as "Gemini 4 Argon Weekly Limit" with
// `group` set, which the "·" pattern cannot split.
function groupedAntigravityQuota(
  model: { model: string; group?: string; cycle?: string },
  quotaName: string,
): { group: string; label: string } | null {
  if (!model.group) return null;
  const rest = quotaName.toLowerCase().startsWith(model.group.toLowerCase())
    ? quotaName.slice(model.group.length).replace(/^\s*·?\s*/, '').replace(/\s+Limit$/i, '').trim()
    : '';
  if (!rest || /^(weekly|five hour|5h)$/i.test(rest)) {
    const label = (model.cycle && ANTIGRAVITY_CYCLE_LABELS[model.cycle])
      ?? (rest ? (ANTIGRAVITY_WINDOW_LABELS[rest.toLowerCase()] ?? rest) : null);
    if (label) return { group: model.group, label };
  }
  return null;
}

// Extract all usage metrics from agent data
export function getAllMetrics(agent: AgentUsageData): UsageMetric[] {
  const metrics: UsageMetric[] = [];
  if (!agent.usage) return metrics;

  // Claude metrics
  if (agent.usage.session) {
    metrics.push({
      label: 'Session',
      percent: agent.usage.session.percent,
      resetsIn: agent.usage.session.resetsIn,
      historyKey: 'session',
      cycle: 'session'
    });
  }
  if (agent.usage.weeklyAll) {
    metrics.push({
      label: 'Weekly',
      percent: agent.usage.weeklyAll.percent,
      resetsIn: agent.usage.weeklyAll.resetsIn,
      historyKey: 'weeklyAll',
      cycle: 'weekly'
    });
  }
  if (agent.usage.weeklySonnet) {
    metrics.push({
      label: 'Sonnet',
      percent: agent.usage.weeklySonnet.percent,
      resetsIn: agent.usage.weeklySonnet.resetsIn,
      historyKey: 'weeklySonnet',
      cycle: 'weekly'
    });
  }
  if (agent.usage.weeklyFable) {
    metrics.push({
      label: 'Fable',
      percent: agent.usage.weeklyFable.percent,
      resetsIn: agent.usage.weeklyFable.resetsIn,
      historyKey: 'weeklyFable',
      cycle: 'weekly'
    });
  }
  // Gemini / Antigravity models
  if (agent.usage.models) {
    const isAntigravity = agent.name.toLowerCase() === 'antigravity';
    for (const model of agent.usage.models) {
      const history = {
        historyKey: `model:${model.model}`,
        cycle: (model.cycle && ANTIGRAVITY_CYCLES[model.cycle]) ?? 'session',
      };
      if (isAntigravity) {
        // Quota windows already carry product labels, not model IDs. Preserve
        // their spelling (e.g. "Claude and GPT") before formatting model IDs.
        const quotaName = stripRemainingSuffix(model.model);
        const quotaWindow = parseAntigravityQuotaWindow(quotaName) ?? groupedAntigravityQuota(model, quotaName);
        if (quotaWindow) {
          metrics.push({
            label: quotaWindow.label,
            group: quotaWindow.group,
            title: quotaName,
            percent: model.percentUsed,
            resetsIn: model.resetsIn,
            ...history
          });
          continue;
        }
        // Keep the full model name (incl. "Gemini" prefix and thinking level) for the tooltip,
        // but shorten the visible label.
        const fullName = stripRemainingSuffix(getModelDisplayName(model.model));
        const { display, plain } = formatAntigravityModelLabel(fullName);
        metrics.push({
          label: plain,
          displayLabel: display,
          title: fullName,
          percent: model.percentUsed,
          resetsIn: model.resetsIn,
          ...history
        });
      } else {
        metrics.push({
          label: stripRemainingSuffix(getModelDisplayName(model.model, { compactGemini: true })),
          percent: model.percentUsed,
          resetsIn: model.resetsIn,
          ...history
        });
      }
    }
  }

  // Codex metrics - fiveHour (session) first, then weekly
  if (agent.usage.fiveHour) {
    metrics.push({
      label: 'Session',
      percent: agent.usage.fiveHour.percentUsed,
      resetsIn: agent.usage.fiveHour.resetsIn,
      historyKey: 'fiveHour',
      cycle: 'five_hour'
    });
  }
  // Codex weekly uses percentUsed, not percent
  if (agent.usage.weekly && !agent.usage.weeklyAll) {
    const weeklyData = agent.usage.weekly as { percentUsed?: number; percent?: number; resetsIn?: string };
    metrics.push({
      label: 'Weekly',
      percent: weeklyData.percentUsed ?? weeklyData.percent ?? 0,
      resetsIn: weeklyData.resetsIn,
      historyKey: 'weekly',
      cycle: 'weekly'
    });
  }

  return metrics;
}

// Get primary metric for collapsed view
export function getPrimaryMetric(agent: AgentUsageData): UsageMetric | null {
  const metrics = getAllMetrics(agent);
  return metrics.length > 0 ? metrics[0] : null;
}

// Rows with an explicit tooltip (Antigravity, whose visible label is shortened)
// must still report their reset countdown — the same "Resets in ..." suffix every
// other provider's rows get — so the two are composed rather than one replacing
// the other. Agent Tank omits the countdown for quotas it has no window for.
export function getMetricTooltip(metric: UsageMetric): string {
  const resets = metric.resetsIn ? `Resets in ${metric.resetsIn}` : null;
  if (metric.title) return resets ? `${metric.title} · ${resets}` : metric.title;
  return resets ?? metric.label;
}
