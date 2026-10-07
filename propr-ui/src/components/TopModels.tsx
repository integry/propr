/**
 * Per-model breakdown for the Analytics console: runs, tokens and cost.
 *
 * A model is credited with runs — agent executions — not tasks. One task
 * usually takes several runs, often on different models (one writes the code,
 * another reviews it, the first fixes it), so a per-model task count would
 * credit the same deliverable to every model that touched it. Task volume is
 * reported once, in the totals band.
 *
 * Presentational: the page reads the overview once per timeframe and hands it
 * in, so the table and the metric strip above it can never disagree. The
 * heading belongs to the pane that holds the table.
 *
 * Every model goes through one formatter, so a catalogue model and an id the
 * catalogue has since dropped read the same way (`Claude Opus 5.5`,
 * `GPT-5.6`) instead of a display name beside a raw slug.
 *
 * Each row opens the LLM log filtered to its model.
 */

import React from 'react';
import type { StatsOverviewModelUsage, StatsOverviewResponse } from '../api/taskStatsApi';
import { formatModelName } from '../utils/modelDisplay';
import { ProviderLogo } from './ui/ProviderLogo';
import { SkeletonBlock, SkeletonRegion } from './ui/Skeleton';
import { SystemAlert } from './ui/SystemAlert';
import { formatCompactNumber, formatUsd } from './Analytics/analyticsFormat';
import { DrillDownCell, DrillDownRow } from './Analytics/DrillDownRow';
import { modelLogsHref } from './Analytics/drillDownLinks';

// Model icon component using ProviderLogo for visual grouping
const ModelIcon: React.FC<{ modelId: string }> = ({ modelId }) => {
  const getModelFamily = (id: string): string => {
    const lower = id.toLowerCase();
    if (lower.includes('antigravity')) return 'antigravity';
    if (lower.includes('claude') || lower.includes('anthropic')) return 'claude';
    if (lower.includes('gpt') || lower.includes('openai')) return 'openai';
    if (lower.includes('gemini') || lower.includes('google')) return 'gemini';
    if (lower.includes('llama') || lower.includes('meta')) return 'llama';
    return 'other';
  };

  const family = getModelFamily(modelId);
  const iconColors: Record<string, string> = {
    claude: 'bg-violet-100 text-violet-600',
    openai: 'bg-emerald-100 text-emerald-600',
    antigravity: 'bg-fuchsia-100 text-fuchsia-600',
    gemini: 'bg-blue-100 text-blue-600',
    llama: 'bg-orange-100 text-orange-600',
    other: 'bg-gray-100 text-gray-600',
  };

  return (
    <div className={`flex h-5 w-5 flex-none items-center justify-center rounded-sm ${iconColors[family]}`}>
      <ProviderLogo provider={modelId} className="h-3.5 w-3.5" />
    </div>
  );
};

interface TopModelsProps {
  overview: StatsOverviewResponse | null;
  loading: boolean;
  error?: string | null;
  limit?: number;
}

/** A row whose token or cost figure the server did not report. */
type ModelRow = Omit<StatsOverviewModelUsage, 'tokens' | 'cost_usd'> & { tokens: number | null; cost_usd: number | null };

/**
 * The per-model breakdown, or the task counts alone from a server that
 * predates it, with tokens and cost left unknown rather than shown as zero.
 */
const modelRows = (overview: StatsOverviewResponse): ModelRow[] =>
  overview.model_usage
    ?? Object.entries(overview.usage.models)
      .map(([model, tasks]) => ({ model, tasks, tokens: null, cost_usd: null }))
      .sort((a, b) => b.tasks - a.tasks);

const HEAD = 'whitespace-nowrap px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 sm:px-4';
/**
 * One width for every figure column, so tasks, tokens and cost read as three
 * evenly spaced columns instead of a cluster pinched against the right edge.
 */
const METRIC_COLUMN = 'w-20 2xl:w-28';
const CELL = 'px-3 py-2 text-sm tabular-nums sm:px-4';
const UNKNOWN = '—';

/** Runs, or tasks from a server that predates run counts. */
const TableHead: React.FC<{ countsRuns?: boolean }> = ({ countsRuns = true }) => (
  <thead>
    <tr className="border-b border-slate-200">
      <th className={`${HEAD} text-left`}>Model</th>
      <th
        className={`${HEAD} ${METRIC_COLUMN} text-right`}
        title={countsRuns ? 'Agent executions on the model in the period' : 'Distinct tasks with a run on the model'}
      >
        {countsRuns ? 'Runs' : 'Tasks'}
      </th>
      <th className={`${HEAD} ${METRIC_COLUMN} text-right`}>Tokens</th>
      <th className={`${HEAD} ${METRIC_COLUMN} text-right`}>Cost</th>
    </tr>
  </thead>
);

const TopModels: React.FC<TopModelsProps> = ({ overview, loading, error, limit }) => {
  if (loading) {
    return (
      <SkeletonRegion label="Loading models…">
        <table className="w-full table-fixed" aria-hidden="true">
          <TableHead />
          <tbody>
            {[...Array(3)].map((_, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-b-0">
                <td className={CELL}><SkeletonBlock className="h-5 w-32" /></td>
                <td className={CELL}><SkeletonBlock className="ml-auto h-4 w-6" /></td>
                <td className={CELL}><SkeletonBlock className="ml-auto h-4 w-10" /></td>
                <td className={CELL}><SkeletonBlock className="ml-auto h-4 w-12" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </SkeletonRegion>
    );
  }

  if (error) {
    return <div className="p-3 sm:px-4"><SystemAlert>{error}</SystemAlert></div>;
  }

  const rows = overview ? modelRows(overview) : [];
  if (rows.length === 0) {
    return <p className="px-3 py-4 text-sm text-slate-500 sm:px-4">No model usage in this period.</p>;
  }

  const displayModels = limit ? rows.slice(0, limit) : rows;
  const countsRuns = rows.every(row => row.runs !== undefined);

  return (
    <table className="w-full table-fixed" data-testid="model-breakdown-table">
      <TableHead countsRuns={countsRuns} />
      <tbody>
        {displayModels.map(row => (
          <DrillDownRow key={row.model} to={modelLogsHref(row.model)}>
            <DrillDownCell to={modelLogsHref(row.model)} label={`LLM log for ${row.model}`} className={CELL}>
              <ModelIcon modelId={row.model} />
              <span className="truncate font-medium text-slate-800" title={row.model}>
                {formatModelName(row.model)}
              </span>
            </DrillDownCell>
            <td className={`${CELL} text-right text-slate-800`} data-testid="model-run-count">
              {(countsRuns ? row.runs ?? 0 : row.tasks).toLocaleString()}
            </td>
            <td className={`${CELL} text-right text-slate-600`}>
              {row.tokens === null ? UNKNOWN : formatCompactNumber(row.tokens)}
            </td>
            <td className={`${CELL} text-right text-slate-600`}>
              {row.cost_usd === null ? UNKNOWN : formatUsd(row.cost_usd)}
            </td>
          </DrillDownRow>
        ))}
      </tbody>
    </table>
  );
};

export default TopModels;
