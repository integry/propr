/**
 * Configuration functions for GitHub issue job.
 */

import { Redis } from 'ioredis';
import { logger, loadPrLabel, loadPrimaryProcessingLabels, getDefaultModel } from '@propr/core';

export const redisClient = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const DEFAULT_MODEL_NAME: string | null = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel() || null;

export async function getPrimaryProcessingLabels(): Promise<string[]> {
  try {
    if (process.env.CONFIG_REPO) return await loadPrimaryProcessingLabels();
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Failed to load primary processing labels from config, using fallback');
  }
  if (process.env.PRIMARY_PROCESSING_LABELS) {
    return process.env.PRIMARY_PROCESSING_LABELS.split(',').map(l => l.trim()).filter(l => l);
  }
  return [process.env.AI_PRIMARY_TAG || 'AI'];
}

export async function getPrLabel(): Promise<string> {
  try {
    if (process.env.CONFIG_REPO) return await loadPrLabel();
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Failed to load PR label from config, using fallback');
  }
  return process.env.PR_LABEL || 'propr';
}
