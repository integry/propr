import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Maximize2, ZoomIn } from 'lucide-react';
import { trustedApplicationPreviewMediaUrl, trustedPreviewMedia, type PublishedVisualPreview } from '@propr/shared';
import { PreviewImage, PreviewVideo } from '../PreviewMedia';
import PreviewLightbox from '../PreviewLightbox';

/** The width a capture was taken at, when its title or description says, e.g. `1920`. */
function captureWidth(preview: PublishedVisualPreview): string | null {
  const text = `${preview.title} ${preview.description ?? ''}`;
  return text.match(/\b(\d{3,4})\s*(?:px\b|[x×]\s*\d{3,4})/i)?.[1] ?? null;
}

/** The viewport a capture was taken at, when its title or description says, e.g. `Desktop 1920px`. */
function captureViewport(preview: PublishedVisualPreview): string | null {
  const text = `${preview.title} ${preview.description ?? ''}`;
  const kind = text.match(/\b(desktop|tablet|mobile)\b/i)?.[1];
  const width = captureWidth(preview);
  const label = kind ? kind[0].toUpperCase() + kind.slice(1).toLowerCase() : null;
  if (label && width) return `${label} ${width}px`;
  return label ?? (width ? `${width}px` : null);
}

/** A short name for a capture in the switcher: its viewport, a before/after side, or its position. */
function captureLabel(preview: PublishedVisualPreview, index: number): string {
  const side = preview.title.match(/\b(before|after)\b/i)?.[1];
  if (side) return side[0].toUpperCase() + side.slice(1).toLowerCase();
  return captureViewport(preview) ?? `Capture ${index + 1}`;
}

const pill = 'inline-flex h-6 max-w-[10rem] items-center rounded px-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';

/**
 * Visual evidence published by this specific task run, in a fixed-height canvas: the framed capture
 * on the left, what it shows on the right, a switcher between captures and a lightbox for the pixels.
 * Renders nothing when the run published none.
 */
export default function TaskVisualPreviews({ previews }: { previews?: PublishedVisualPreview[] }) {
  const media = trustedPreviewMedia(previews, 8);
  // Tracked by url, not index: polling refreshes reorder and replace the list.
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const selected = media.find(preview => preview.url === selectedUrl) ?? media[0];
  // Videos keep their native controls in the frame; only images form the lightbox sequence.
  const images = media.filter(preview => preview.type === 'image');
  const lightboxIndex = lightboxUrl === null ? -1 : images.findIndex(image => image.url === lightboxUrl);
  useEffect(() => {
    if (lightboxUrl !== null && lightboxIndex < 0) setLightboxUrl(null);
  }, [lightboxUrl, lightboxIndex]);
  if (!selected) return null;

  const openLightbox = (trigger: HTMLButtonElement) => {
    opener.current = trigger;
    setLightboxUrl(selected.url);
  };
  const viewport = captureViewport(selected);
  const width = captureWidth(selected);
  const isImage = selected.type === 'image';

  return <section aria-labelledby="task-visual-previews-heading" className="border-b border-slate-200 px-4 py-3">
    <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
      <h2 id="task-visual-previews-heading" className="m-0 text-[11px] font-bold uppercase tracking-widest text-slate-500">
        Visual evidence{' '}
        <span className="ml-1.5 font-mono font-normal normal-case tracking-normal">({media.length} {media.length === 1 ? 'capture' : 'captures'})</span>
      </h2>
      <div className="flex min-w-0 items-center gap-2">
        {media.length > 1 && (
          <div role="group" aria-label="Captures" className="inline-flex min-w-0 flex-wrap rounded-md border border-slate-200 bg-slate-50 p-0.5">
            {media.map((preview, index) => (
              <button key={preview.url} type="button" aria-pressed={preview === selected} title={preview.title}
                onClick={() => setSelectedUrl(preview.url)}
                className={`${pill} ${preview === selected ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                <span className="truncate">{captureLabel(preview, index)}</span>
              </button>
            ))}
          </div>
        )}
        {isImage && (
          <button type="button" aria-haspopup="dialog" onClick={event => openLightbox(event.currentTarget)}
            className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            Lightbox
          </button>
        )}
      </div>
    </div>

    <figure data-testid="visual-evidence-canvas" className="m-0 mt-2 flex min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white sm:h-56 sm:flex-row">
      {/* A light browser window frames the capture as an artifact, not live UI, without a block of black ink. */}
      <div className="h-44 flex-none bg-slate-50 p-2 sm:h-full sm:w-3/5">
        <div data-testid="visual-evidence-window" className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div aria-hidden="true" className="flex h-6 flex-none items-center justify-between gap-2 border-b border-slate-200 bg-slate-100 px-3">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-slate-300" />
              <span className="h-2 w-2 rounded-full bg-slate-300" />
              <span className="h-2 w-2 rounded-full bg-slate-300" />
            </span>
            {width && <span data-testid="visual-evidence-window-size" className="truncate font-mono text-[10px] text-slate-400">{width}px</span>}
          </div>
          <div className="min-h-0 flex-1">
            {isImage
              ? <button type="button" aria-haspopup="dialog" aria-label={`Open full-size preview: ${selected.title}`}
                onClick={event => openLightbox(event.currentTarget)}
                className="group relative block h-full w-full cursor-zoom-in overflow-hidden bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400">
                <PreviewImage key={selected.url} preview={selected} className="h-full w-full object-cover object-left-top" />
                <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center bg-slate-950/0 opacity-0 transition group-hover:bg-slate-950/40 group-hover:opacity-100 group-focus-visible:bg-slate-950/40 group-focus-visible:opacity-100">
                  <span className="inline-flex items-center gap-1.5 rounded bg-slate-900/90 px-2.5 py-1 text-xs font-medium text-white">
                    <ZoomIn className="h-3.5 w-3.5" />
                    Click to inspect full resolution
                  </span>
                </span>
              </button>
              : <PreviewVideo key={selected.url} preview={selected} className="h-full w-full bg-white object-contain" />}
          </div>
        </div>
      </div>
      <figcaption className="h-28 min-w-0 flex-none overflow-y-auto border-t border-slate-200 p-3 sm:h-auto sm:flex-1 sm:border-l sm:border-t-0">
        <p className="m-0 break-words text-sm font-semibold text-slate-900">{selected.title}</p>
        {selected.description && <p className="m-0 mt-1 whitespace-pre-line break-words text-xs leading-5 text-slate-600">{selected.description}</p>}
        <dl className="m-0 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          {viewport && <div className="flex gap-1"><dt>Viewport:</dt><dd className="m-0 font-mono text-slate-700">{viewport}</dd></div>}
          <div className="flex gap-1"><dt>Type:</dt><dd className="m-0 text-slate-700">{isImage ? 'Screenshot' : 'Video'}</dd></div>
        </dl>
        {!trustedApplicationPreviewMediaUrl(selected.url) && <a href={selected.url} target="_blank" rel="noopener noreferrer" aria-label={`Open original: ${selected.title}`}
          className="mt-2 inline-flex min-h-6 items-center gap-1 text-xs font-medium text-sky-700 hover:underline">
          Original <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>}
      </figcaption>
    </figure>

    {lightboxIndex >= 0 && <PreviewLightbox previews={images} index={lightboxIndex} onIndexChange={index => { setLightboxUrl(images[index]?.url ?? null); setSelectedUrl(images[index]?.url ?? null); }}
      onClose={() => setLightboxUrl(null)} returnFocusTo={opener.current} />}
  </section>;
}
