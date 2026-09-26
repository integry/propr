import { trustedGitHubAttachmentUrl, VISUAL_PREVIEW_MARKER } from './visualPreviewService.js';

const MAX_PREVIEW_ASSETS = 8;

export type { PublishedVisualPreview } from '@propr/shared';
import type { PublishedVisualPreview } from '@propr/shared';

function unescapeMarkdownText(value: string): string {
  return value.replace(/\\([\\`*_[\]{}()<>#+.!|])/g, '$1');
}

/**
 * Extract only the hosted media emitted by renderVisualPreviewSection. The
 * strict GitHub attachment allowlist keeps PR-authored Markdown from becoming
 * an arbitrary media source in downstream operator UIs.
 */
export function parsePublishedVisualPreviews(body: unknown): PublishedVisualPreview[] {
  if (typeof body !== 'string') return [];
  const markerIndex = body.lastIndexOf(VISUAL_PREVIEW_MARKER);
  if (markerIndex < 0) return [];

  const lines = body.slice(markerIndex + VISUAL_PREVIEW_MARKER.length).split(/\r?\n/);
  const previews: PublishedVisualPreview[] = [];
  for (let index = 0; index < lines.length && previews.length < MAX_PREVIEW_ASSETS; index += 1) {
    if (!lines[index].startsWith('### ')) continue;
    const title = unescapeMarkdownText(lines[index].slice(4).trim()).slice(0, 120);
    let mediaIndex = index + 1;
    while (mediaIndex < lines.length && !lines[mediaIndex].trim()) mediaIndex += 1;
    const media = /^!\[([^\]]*)\]\((https:\/\/github\.com\/user-attachments\/assets\/[A-Za-z0-9_-]+)\)$/.exec(lines[mediaIndex] || '');
    if (!title || !media) continue;
    const url = trustedGitHubAttachmentUrl(media[2]);
    if (!url) continue;

    const descriptionLines: string[] = [];
    let descriptionIndex = mediaIndex + 1;
    while (descriptionIndex < lines.length && !lines[descriptionIndex].startsWith('### ')) {
      const line = lines[descriptionIndex];
      if (!line.startsWith('[View the full-resolution original in ProPR Connect](')
        && !line.startsWith('The GitHub inline attachment could not be published')
        && !line.startsWith('The preview could not be uploaded to GitHub')) descriptionLines.push(line);
      descriptionIndex += 1;
    }
    const description = unescapeMarkdownText(descriptionLines.join(' ').replace(/\s+/g, ' ').trim()).slice(0, 300);
    previews.push({
      type: media[1].trim() ? 'image' : 'video',
      title,
      ...(description ? { description } : {}),
      url,
    });
    index = descriptionIndex - 1;
  }
  return previews;
}
