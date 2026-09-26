import { loadPrLabel, logger } from '@propr/core';

/** Resolve the label applied to ProPR-managed pull requests. */
export async function getPrLabel(): Promise<string> {
  try {
    if (process.env.CONFIG_REPO) return await loadPrLabel();
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Failed to load PR label from config, using fallback');
  }
  return process.env.PR_LABEL || 'propr';
}
