import { useEffect, useState } from 'react';
import type { AnalyticsTimeframe } from '@propr/shared';

export interface TimeframeRead<T> {
  data: T | null;
  error: string | null;
  /** True until a read for the current timeframe has settled. */
  loading: boolean;
}

interface Settled<T> {
  timeframe: AnalyticsTimeframe;
  data: T | null;
  error: string | null;
}

/**
 * One Analytics read, once per timeframe.
 *
 * Every result is tagged with the timeframe it answers, so data from another
 * timeframe is never shown under this one's label: a new timeframe reads as
 * loading until its own response lands. A response for a timeframe the page
 * has already left is dropped, so a slow read can never overwrite a newer one.
 *
 * `load` must be stable (a module-level API function).
 */
export function useTimeframeRead<T>(
  load: (timeframe: AnalyticsTimeframe) => Promise<T>,
  timeframe: AnalyticsTimeframe,
  failureMessage: string,
): TimeframeRead<T> {
  const [result, setResult] = useState<Settled<T> | null>(null);

  useEffect(() => {
    let active = true;
    load(timeframe)
      .then(data => { if (active) setResult({ timeframe, data, error: null }); })
      .catch(error => {
        console.error(`${failureMessage}:`, error);
        if (active) setResult({ timeframe, data: null, error: failureMessage });
      });
    return () => { active = false; };
  }, [load, timeframe, failureMessage]);

  const settled = result?.timeframe === timeframe ? result : null;
  return { data: settled?.data ?? null, error: settled?.error ?? null, loading: !settled };
}
