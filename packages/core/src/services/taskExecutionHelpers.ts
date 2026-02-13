import fs from 'fs-extra';
import path from 'path';
import type { Logger } from 'pino';
import type { EnhancedLogger } from '../utils/logger.js';

export interface PlanTaskAttachment {
  id: string;
  originalName: string;
  storedPath: string;
  mimeType: string;
  size: number;
  tokenEstimate: number;
  type: 'image' | 'text';
}

interface BuildUserNotesOptions {
  notes: string | undefined;
  attachments: PlanTaskAttachment[];
  correlatedLogger: Logger | EnhancedLogger;
}

/**
 * Read and embed a single image attachment as base64.
 * Returns the markdown string or null if the file couldn't be read.
 */
async function embedImageAttachment(
  attachment: PlanTaskAttachment,
  correlatedLogger: Logger | EnhancedLogger
): Promise<string | null> {
  const filePath = path.join(process.cwd(), attachment.storedPath);
  const fileExists = await fs.pathExists(filePath);

  if (!fileExists) {
    correlatedLogger.warn({ attachmentId: attachment.id, originalName: attachment.originalName }, 'Image attachment file not found');
    return null;
  }

  const imageBuffer = await fs.readFile(filePath);
  const base64Data = imageBuffer.toString('base64');
  const mimeType = attachment.mimeType || 'image/webp';

  correlatedLogger.info({
    attachmentId: attachment.id,
    originalName: attachment.originalName,
    size: imageBuffer.length
  }, 'Embedded image as base64 in comment');

  const lines = [
    `**${attachment.originalName}:**`,
    `<img src="data:${mimeType};base64,${base64Data}" alt="${attachment.originalName}" />`,
    ''
  ];
  return lines.join('\n');
}

/**
 * Read and format a single text attachment as a code block.
 * Returns the markdown string or null if the file couldn't be read.
 */
async function formatTextAttachment(
  attachment: PlanTaskAttachment,
  correlatedLogger: Logger | EnhancedLogger
): Promise<string | null> {
  const filePath = path.join(process.cwd(), attachment.storedPath);
  const fileExists = await fs.pathExists(filePath);

  if (!fileExists) {
    correlatedLogger.warn({ attachmentId: attachment.id, originalName: attachment.originalName }, 'Text attachment file not found');
    return null;
  }

  const content = await fs.readFile(filePath, 'utf-8');
  const ext = path.extname(attachment.originalName).toLowerCase().replace('.', '') || 'txt';

  const lines = [
    `**${attachment.originalName}:**`,
    '```' + ext,
    content.trim(),
    '```',
    ''
  ];
  return lines.join('\n');
}

/**
 * Process a single attachment and return its markdown representation.
 */
async function processAttachment(
  attachment: PlanTaskAttachment,
  correlatedLogger: Logger | EnhancedLogger
): Promise<string | null> {
  try {
    if (attachment.type === 'image') {
      return await embedImageAttachment(attachment, correlatedLogger);
    }
    return await formatTextAttachment(attachment, correlatedLogger);
  } catch (err) {
    correlatedLogger.error({
      attachmentId: attachment.id,
      originalName: attachment.originalName,
      error: (err as Error).message
    }, 'Failed to process attachment');
    return null;
  }
}

/**
 * Build a user notes comment body with attachments.
 * Images are embedded directly as base64 data URIs for GitHub compatibility.
 * Text files are displayed with their content inline as code blocks.
 */
export async function buildUserNotesCommentBody(options: BuildUserNotesOptions): Promise<string | null> {
  const { notes, attachments, correlatedLogger } = options;

  if (!notes && attachments.length === 0) {
    return null;
  }

  const parts: string[] = [];
  parts.push('## 📝 User Notes\n');

  if (notes && notes.trim()) {
    parts.push(notes.trim());
    parts.push('');
  }

  if (attachments.length > 0) {
    parts.push('### Attachments\n');

    for (const attachment of attachments) {
      const attachmentMarkdown = await processAttachment(attachment, correlatedLogger);
      if (attachmentMarkdown) {
        parts.push(attachmentMarkdown);
      }
    }
  }

  const body = parts.join('\n').trim();
  return body || null;
}
