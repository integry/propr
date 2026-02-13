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
  draftId: string;
  correlatedLogger: Logger | EnhancedLogger;
}

/**
 * Get the public base URL for attachments.
 * Uses API_PUBLIC_URL since attachments are served by the API.
 * Falls back to WEB_UI_URL or FRONTEND_URL with /api prefix for backwards compatibility.
 */
function getAttachmentBaseUrl(): string {
  // API_PUBLIC_URL is the public URL for the API (e.g., https://pr-741-api.gitfix.dev)
  if (process.env.API_PUBLIC_URL) {
    return process.env.API_PUBLIC_URL;
  }
  // Fallback to frontend URL (for local development where API is proxied)
  return process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://api.gitfix.dev';
}

/**
 * Build a direct URL for an image attachment.
 * Returns the HTML img tag with the image embedded using the public URL.
 * Uses HTML img tags (like GitHub does) for better compatibility.
 */
function embedImageAttachment(
  attachment: PlanTaskAttachment,
  draftId: string,
  correlatedLogger: Logger | EnhancedLogger
): string {
  const baseUrl = getAttachmentBaseUrl();
  const attachmentUrl = `${baseUrl}/api/planner/drafts/${draftId}/attachments/${attachment.id}`;

  correlatedLogger.info({
    attachmentId: attachment.id,
    originalName: attachment.originalName,
    attachmentUrl
  }, 'Embedded image with direct URL in comment');

  const lines = [
    `**${attachment.originalName}:**`,
    `<img alt="${attachment.originalName}" src="${attachmentUrl}" />`,
    ''
  ];
  return lines.join('\n');
}

/**
 * Format a text attachment as a link.
 * Returns a markdown link to the attachment instead of embedding content inline.
 */
function linkTextAttachment(
  attachment: PlanTaskAttachment,
  draftId: string,
  correlatedLogger: Logger | EnhancedLogger
): string {
  const baseUrl = getAttachmentBaseUrl();
  const attachmentUrl = `${baseUrl}/api/planner/drafts/${draftId}/attachments/${attachment.id}`;

  correlatedLogger.info({
    attachmentId: attachment.id,
    originalName: attachment.originalName,
    attachmentUrl
  }, 'Linked text attachment in comment');

  const lines = [
    `**${attachment.originalName}:** [Download](${attachmentUrl})`,
    ''
  ];
  return lines.join('\n');
}

/**
 * Process a single attachment and return its markdown representation.
 */
function processAttachment(
  attachment: PlanTaskAttachment,
  draftId: string,
  correlatedLogger: Logger | EnhancedLogger
): string | null {
  try {
    if (attachment.type === 'image') {
      return embedImageAttachment(attachment, draftId, correlatedLogger);
    }
    return linkTextAttachment(attachment, draftId, correlatedLogger);
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
 * Images are embedded using direct URLs to the attachment endpoint.
 * Text files are linked to the attachment endpoint for download.
 */
export function buildUserNotesCommentBody(options: BuildUserNotesOptions): string | null {
  const { notes, attachments, draftId, correlatedLogger } = options;

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
      const attachmentMarkdown = processAttachment(attachment, draftId, correlatedLogger);
      if (attachmentMarkdown) {
        parts.push(attachmentMarkdown);
      }
    }
  }

  const body = parts.join('\n').trim();
  return body || null;
}
