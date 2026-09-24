import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { PublishedVisualPreview } from '@propr/shared';
import { PreviewImage } from './PreviewMedia';
import PreviewLightbox from './PreviewLightbox';

/**
 * Full-width evidence stack shared by the task and goal detail screens: every preview spans the
 * reading column, images open the in-app lightbox and videos keep their native controls inline.
 * Callers pass media that already passed `trustedPreviewMedia`.
 */
export default function VisualPreviewGallery({ previews, className = '' }: { previews: PublishedVisualPreview[]; className?: string }) {
  // The open preview is tracked by url, not index: polling refreshes reorder and replace the list, and
  // an index would silently swap the image under the reader.
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  // Videos keep their native controls inline; only images form the lightbox sequence.
  const images = previews.filter(preview => preview.type === 'image');
  const openIndex = openUrl === null ? -1 : images.findIndex(image => image.url === openUrl);
  // A refresh can drop the open preview; clear the selection so a later refresh cannot reopen it unasked.
  useEffect(() => {
    if (openUrl !== null && openIndex < 0) setOpenUrl(null);
  }, [openUrl, openIndex]);
  if (!previews.length) return null;
  return <div className={`flex min-w-0 flex-col gap-4 ${className}`}>
    {previews.map(preview => <figure key={preview.url} className="w-full min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      {preview.type === 'image'
        ? <button type="button" aria-haspopup="dialog" aria-label={`Open full-size preview: ${preview.title}`}
          onClick={event => { opener.current = event.currentTarget; setOpenUrl(preview.url); }}
          className="block w-full cursor-zoom-in bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500">
          <PreviewImage preview={preview} className="max-h-[65vh] w-full object-contain" />
        </button>
        : <video src={preview.url} aria-label={preview.title} controls preload="metadata" playsInline className="aspect-video max-h-[65vh] w-full bg-slate-950" />}
      <figcaption className="p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 break-words text-sm font-medium text-slate-800">{preview.title}</p>
          <a href={preview.url} target="_blank" rel="noopener noreferrer" aria-label={`Open original: ${preview.title}`}
            className="inline-flex min-h-6 shrink-0 items-center gap-1 text-xs font-medium text-sky-700 hover:underline">
            Original <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </div>
        {preview.description && <p className="mt-1 break-words text-xs leading-5 text-slate-500">{preview.description}</p>}
      </figcaption>
    </figure>)}
    {openIndex >= 0 && <PreviewLightbox previews={images} index={openIndex} onIndexChange={index => setOpenUrl(images[index]?.url ?? null)}
      onClose={() => setOpenUrl(null)} returnFocusTo={opener.current} />}
  </div>;
}
