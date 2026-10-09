/**
 * The cache-savings price lookup the overview is wired with.
 */

import { getOfficialModelPricing, getOpenRouterId } from '@propr/core';
import type { CachePriceLookup } from './analyticsAggregates.js';

/**
 * Official first-party prices only, so an analytics read never waits on a
 * pricing fetch. `OFFICIAL_MODEL_PRICING` is per token, the unit
 * `loadCacheUsage` multiplies token counts by.
 */
export const officialCachePrice: CachePriceLookup = model => {
  try {
    return getOfficialModelPricing(getOpenRouterId(model));
  } catch {
    return null;
  }
};
