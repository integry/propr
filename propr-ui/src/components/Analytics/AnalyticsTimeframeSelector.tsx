/**
 * The one timeframe control for the Analytics page.
 *
 * From `sm` up it is a compact segmented control, like the dashboard's stats
 * period toggle. On phones six buttons would overflow a 320px header, so it
 * becomes a native select with the full labels instead.
 */

import React from 'react';
import {
  ANALYTICS_TIMEFRAMES,
  ANALYTICS_TIMEFRAME_LABELS,
  ANALYTICS_TIMEFRAME_SHORT_LABELS,
  parseAnalyticsTimeframe,
  type AnalyticsTimeframe,
} from '@propr/shared';

interface AnalyticsTimeframeSelectorProps {
  value: AnalyticsTimeframe;
  onChange: (timeframe: AnalyticsTimeframe) => void;
}

const AnalyticsTimeframeSelector: React.FC<AnalyticsTimeframeSelectorProps> = ({ value, onChange }) => (
  <div className="shrink-0">
    <div className="hidden rounded-sm bg-slate-200/70 p-0.5 sm:inline-flex" role="group" aria-label="Analytics timeframe">
      {ANALYTICS_TIMEFRAMES.map(option => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          aria-label={ANALYTICS_TIMEFRAME_LABELS[option]}
          title={ANALYTICS_TIMEFRAME_LABELS[option]}
          onClick={() => onChange(option)}
          className={`rounded-sm px-2.5 py-1 text-xs font-semibold transition-colors ${
            value === option ? 'bg-white text-slate-800' : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          {ANALYTICS_TIMEFRAME_SHORT_LABELS[option]}
        </button>
      ))}
    </div>
    <select
      aria-label="Analytics timeframe"
      value={value}
      onChange={event => onChange(parseAnalyticsTimeframe(event.target.value))}
      className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500 sm:hidden"
    >
      {ANALYTICS_TIMEFRAMES.map(option => (
        <option key={option} value={option}>{ANALYTICS_TIMEFRAME_LABELS[option]}</option>
      ))}
    </select>
  </div>
);

export default AnalyticsTimeframeSelector;
