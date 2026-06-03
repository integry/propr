/**
 * Attachment handling utilities for task planning.
 */

import fs from 'fs-extra';
import path from 'path';
import type { Attachment } from '../attachmentService.js';
import type { MinimalLogger, Base64Image, TaskDraftConfig } from '../planning/index.js';
import type { LoadedImages } from './types.js';

/**
 * Parse attachments from draft (stored as JSON string in SQLite)
 */
export function parseAttachments(draftAttachments: string | Attachment[] | undefined): Attachment[] {
  if (typeof draftAttachments === 'string') {
    try {
      return JSON.parse(draftAttachments);
    } catch {
      return [];
    }
  }
  if (Array.isArray(draftAttachments)) {
    return draftAttachments;
  }
  return [];
}

/**
 * Calculate token estimate for base64 image data.
 * Base64 is ~4/3 of original size, then ~4 chars per token, plus XML overhead.
 */
export function calculateBase64Tokens(base64Length: number): number {
  // base64 string is tokenized as text: ~4 chars per token, plus 10% for XML wrapper
  return Math.ceil((base64Length / 4) * 1.1);
}

/**
 * Load image attachments and convert them to base64.
 * Returns both the images and accurate token count based on actual base64 size.
 */
export async function loadImageAttachmentsAsBase64(
  attachments: Attachment[],
  correlatedLogger: MinimalLogger
): Promise<LoadedImages> {
  const base64Images: Base64Image[] = [];
  const imageAttachments = attachments.filter(a => a.type === 'image');
  let totalTokens = 0;

  for (const img of imageAttachments) {
    try {
      const absolutePath = path.isAbsolute(img.storedPath)
        ? img.storedPath
        : path.join(process.cwd(), img.storedPath);
      const imageData = await fs.readFile(absolutePath);
      const base64Data = imageData.toString('base64');
      const imageTokens = calculateBase64Tokens(base64Data.length);
      totalTokens += imageTokens;

      base64Images.push({
        name: img.originalName,
        mimeType: img.mimeType,
        base64Data,
      });
      correlatedLogger.info({ imageName: img.originalName, fileSize: imageData.length, base64Length: base64Data.length, tokens: imageTokens }, 'Loaded image attachment');
    } catch (error) {
      correlatedLogger.warn({ imagePath: img.storedPath, error: (error as Error).message }, 'Failed to load image attachment');
    }
  }

  return { images: base64Images, totalTokens };
}

/**
 * Parse context_config from draft (JSON string from SQLite or object)
 */
export function parseDraftContextConfig(
  contextConfig: string | TaskDraftConfig | null | undefined,
  draftId: string,
  correlatedLogger: MinimalLogger
): TaskDraftConfig | null {
  if (typeof contextConfig === 'string') {
    try {
      return JSON.parse(contextConfig);
    } catch {
      correlatedLogger.warn({ draftId }, 'Failed to parse context_config, using defaults');
      return null;
    }
  }
  if (contextConfig) {
    return contextConfig as TaskDraftConfig;
  }
  return null;
}
