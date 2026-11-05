/**
 * A short sample of a usage series' line, in its color and dash pattern, so a
 * chip, tooltip row or table row names the line exactly as the chart draws it.
 */

import React from 'react';
import type { UsageSeriesStyle } from '../usageHistory/usageHistoryModel';

const UsageSeriesSwatch: React.FC<UsageSeriesStyle> = ({ color, dash }) => (
  <svg width="16" height="8" viewBox="0 0 16 8" className="flex-none" aria-hidden="true" data-dash={dash ?? 'solid'}>
    <line x1="0" y1="4" x2="16" y2="4" stroke={color} strokeWidth="2.5" strokeDasharray={dash} />
  </svg>
);

export default UsageSeriesSwatch;
