/**
 * Utility functions for context preview generation.
 */

import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { ensureImageFitsContext, type Attachment } from '../attachmentService.js';
import type {
  TaskDraftConfig,
  ContextCache,
  ContextData,
  MinimalLogger,
  Base64Image
} from './planningTypes.js';

/**
 * Compute a hash of content-affecting parameters to determine if regeneration is needed.
 */
export function computeContentHash(params: {
  prompt: string;
  baseBranch: string;
  compress: boolean;
  manualFiles: string[];
  attachmentsJson: string;
}): string {
  const data = JSON.stringify([
    params.prompt,
    params.baseBranch,
    params.compress,
    params.manualFiles.sort(),
    params.attachmentsJson
  ]);
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Parse attachments from draft (JSON string from SQLite or array)
 */
export function parseDraftAttachments(attachments: string | Attachment[] | undefined): Attachment[] {
  if (!attachments) return [];
  if (Array.isArray(attachments)) return attachments;
  try {
    return JSON.parse(attachments);
  } catch {
    return [];
  }
}

/**
 * Parse existing context config from draft (may be JSON string from SQLite)
 */
export function parseExistingContextConfig(contextConfig: TaskDraftConfig | string | null | undefined): TaskDraftConfig | null {
  if (!contextConfig) return null;
  if (typeof contextConfig === 'string') {
    try {
      return JSON.parse(contextConfig);
    } catch {
      return null;
    }
  }
  return contextConfig;
}

/**
 * Load images from attachments and convert to base64
 */
export async function loadImagesFromAttachments(
  attachments: Attachment[],
  correlatedLogger: MinimalLogger
): Promise<{ base64Images: Base64Image[]; imageTokens: number }> {
  const base64Images: Base64Image[] = [];
  let imageTokens = 0;

  for (const att of attachments) {
    if (att.mimeType?.startsWith('image/') && att.storedPath) {
      try {
        const absolutePath = path.isAbsolute(att.storedPath)
          ? att.storedPath
          : path.join(process.cwd(), att.storedPath);
        await ensureImageFitsContext(absolutePath, correlatedLogger);
        const data = await fs.readFile(absolutePath);
        const base64Data = data.toString('base64');
        base64Images.push({
          name: att.originalName || path.basename(absolutePath),
          mimeType: att.mimeType,
          base64Data
        });
        imageTokens += Math.ceil((base64Data.length / 4) * 1.1);
      } catch (err) {
        correlatedLogger.warn({ path: att.storedPath, error: (err as Error).message }, 'Failed to load image attachment');
      }
    }
  }

  return { base64Images, imageTokens };
}

/**
 * Extract context data from cache
 */
export function extractContextFromCache(cache: ContextCache): ContextData {
  return {
    repomixContext: cache.repomixContext,
    smartSummaries: cache.smartSummaries,
    autoFilePaths: cache.autoFilePaths,
    includedFiles: cache.includedFiles,
    repomixTokens: cache.repomixTokens,
    smartSummaryTokens: cache.smartSummaryTokens,
    fileTokenCounts: cache.fileTokenCounts,
    fileScores: cache.fileScores || {}
  };
}

/**
 * Get reason for cache invalidation
 */
export function getCacheInvalidationReason(
  cache: ContextCache | undefined,
  contentHash: string,
  cacheHasSufficientLimit: boolean,
  maxTokenLimit: number
): string {
  if (!cache) return 'no cache';
  if (cache.contentHash !== contentHash) return 'content changed';
  if (!cache.fileTokenCounts) return 'missing file token counts';
  if (!cacheHasSufficientLimit) return `cached limit ${cache.cachedMaxTokenLimit} < required ${maxTokenLimit}`;
  return 'unknown';
}

/**
 * Calculate attachment tokens including image overhead
 */
export function calculateAttachmentTokens(attachments: Attachment[], imageTokens: number): number {
  // Add overhead for non-image attachments (rough estimate)
  const nonImageAttachments = attachments.filter(a => !a.mimeType?.startsWith('image/'));
  const nonImageTokens = nonImageAttachments.length * 100; // ~100 tokens per non-image attachment for metadata
  return imageTokens + nonImageTokens;
}

/**
 * Estimate context gathering duration based on file count
 */
export function estimateContextGatheringDuration(fileCount: number): number {
  const baseDurationMs = 5000; // 5 seconds base
  const perFileDurationMs = 50; // 50ms per file
  const maxDurationMs = 30000; // 30 seconds max
  return Math.min(baseDurationMs + (fileCount * perFileDurationMs), maxDurationMs);
}

/**
 * Calculate the token budget for additional context repositories.
 */
export function calculateAdditionalContextBudget(params: {
  targetTokenLimit: number;
  simulatedTokens: number;
  attachmentTokens: number;
  smartSummaryTokens: number;
  contextLevel?: number;
}): number {
  const { targetTokenLimit, simulatedTokens, attachmentTokens, smartSummaryTokens, contextLevel = 50 } = params;
  const targetRepoUsage = simulatedTokens + attachmentTokens + smartSummaryTokens;
  const remainingBudget = targetTokenLimit - targetRepoUsage;
  if (remainingBudget <= 0) return 0;

  if (contextLevel >= 80) {
    return Math.min(targetTokenLimit, remainingBudget);
  }

  const minBudget = Math.floor(targetTokenLimit * 0.2);
  const maxBudget = Math.floor(targetTokenLimit * 0.8);
  return Math.max(minBudget, Math.min(maxBudget, remainingBudget));
}
