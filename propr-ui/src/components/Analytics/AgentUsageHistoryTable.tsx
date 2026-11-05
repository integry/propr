/**
 * The usage chart as numbers: each visible series' latest, lowest and highest
 * reading over the range, for anyone who cannot or would rather not read lines
 * by color.
 */

import React from 'react';
import UsageSeriesSwatch from './UsageSeriesSwatch';
import type { PlottedSeries } from './usageHistoryView';

const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 10) / 10}%`);

const AgentUsageHistoryTable: React.FC<{ series: PlottedSeries[] }> = ({ series }) => (
  <div className="overflow-x-auto">
    <table className="w-full min-w-[420px] text-left text-xs" data-testid="agent-usage-history-table">
      <thead className="border-b border-slate-200 text-slate-500">
        <tr>
          <th scope="col" className="py-1.5 pr-3 font-medium">Metric</th>
          <th scope="col" className="py-1.5 pr-3 text-right font-medium">Latest</th>
          <th scope="col" className="py-1.5 pr-3 text-right font-medium">Lowest</th>
          <th scope="col" className="py-1.5 pr-3 text-right font-medium">Highest</th>
          <th scope="col" className="py-1.5 text-right font-medium">Readings</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 text-slate-700">
        {series.map(entry => (
          <tr key={entry.id}>
            <th scope="row" className="py-1.5 pr-3 font-normal">
              <span className="inline-flex items-center gap-2">
                <UsageSeriesSwatch color={entry.color} dash={entry.dash} />
                {entry.displayLabel}
              </span>
            </th>
            <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">{percent(entry.latest)}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{percent(entry.min)}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">{percent(entry.max)}</td>
            <td className="py-1.5 text-right tabular-nums text-slate-500">{entry.plotted.length}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default AgentUsageHistoryTable;
