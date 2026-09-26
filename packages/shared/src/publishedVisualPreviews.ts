/** Public read-only metadata; sources must first pass the published Markdown parser. */
export interface PublishedVisualPreview {
  type: 'image' | 'video';
  title: string;
  description?: string;
  url: string;
}

export function trustedGitHubAttachmentUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:'
      || parsed.hostname !== 'github.com'
      || parsed.port
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || !/^\/user-attachments\/assets\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Defense at client/JSON boundaries; never discovers media in arbitrary Markdown. */
export function trustedPreviewMedia(value: unknown, limit = 8): PublishedVisualPreview[] {
  if (!Array.isArray(value) || limit < 1) return [];
  const previews: PublishedVisualPreview[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const url = trustedGitHubAttachmentUrl(item.url);
    if (!url || (item.type !== 'image' && item.type !== 'video') || typeof item.title !== 'string' || !item.title.trim()) continue;
    if (previews.some(preview => preview.url === url)) continue;
    previews.push({ type: item.type, title: item.title.slice(0, 120), url,
      ...(typeof item.description === 'string' ? { description: item.description.slice(0, 300) } : {}) });
    if (previews.length >= limit) break;
  }
  return previews;
}
