import { useCallback, useEffect, useRef, useState } from 'react';
import { Film, ImageOff } from 'lucide-react';
import { trustedPreviewMedia, type PublishedVisualPreview } from '@propr/shared';
import { downsampleToCanvas } from './previewDownsampling';
import { usePreviewMediaSource } from './usePreviewMediaSource';

/**
 * `className` replaces the default sizing classes; compact thumbnails keep their canvas downsampling either way.
 * With `onUnavailable`, a failed image renders nothing so the caller can drop its slot instead of showing a placeholder.
 */
export function PreviewImage({ preview, compact = false, className: sizing, onUnavailable }: {
  preview: PublishedVisualPreview; compact?: boolean; className?: string; onUnavailable?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [downsampled, setDownsampled] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const className = sizing ?? (compact ? 'h-12 w-full object-contain bg-slate-900/5 sm:h-14' : 'aspect-video w-full object-contain');
  const source = usePreviewMediaSource(preview.url);

  const draw = useCallback(() => {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!compact || !image || !canvas || !image.complete) return;
    try {
      setDownsampled(downsampleToCanvas(image, canvas, image.clientWidth, image.clientHeight));
    } catch {
      setDownsampled(false); // The native image remains a complete fallback.
    }
  }, [compact]);

  useEffect(() => {
    setFailed(false);
    setDownsampled(false);
  }, [preview.url, source.src]);

  useEffect(() => {
    if (source.status === 'failed') {
      setFailed(true);
      onUnavailable?.();
    }
  }, [onUnavailable, source.status]);

  useEffect(() => {
    const image = imageRef.current;
    if (!compact || failed || !image) return;
    if (image.complete && image.naturalWidth) draw();
    if (typeof ResizeObserver === 'undefined') return;
    // Thumbnail widths change at breakpoints; redraw for the new backing size.
    const observer = new ResizeObserver(() => draw());
    observer.observe(image);
    return () => observer.disconnect();
  }, [compact, draw, failed, preview.url, source.src]);

  if ((failed || source.status === 'failed') && onUnavailable) return null;
  if (failed || source.status === 'failed') return <span role="img" aria-label={`${preview.title} — image unavailable`} className={`${className} flex items-center justify-center bg-slate-100 text-slate-500`}><ImageOff className="h-5 w-5" /></span>;
  if (source.status === 'loading') return <span role="status" aria-label={`${preview.title} — image loading`} className={`${className} block animate-pulse bg-slate-100`} />;
  const image = <img ref={imageRef} src={source.src} alt={preview.title} loading="lazy" onLoad={draw} onError={() => { setFailed(true); onUnavailable?.(); }}
    className={`${className}${compact && downsampled ? ' opacity-0' : ''}`} />;
  if (!compact) return image;
  // The image stays in the DOM for lazy loading, accessibility and fallback; the canvas is presentation only.
  return <span className="relative block h-full">
    {image}
    <canvas ref={canvasRef} aria-hidden="true" data-testid="preview-thumbnail-canvas"
      className={`pointer-events-none absolute inset-0 m-auto ${downsampled ? '' : 'hidden'}`} />
  </span>;
}

/** Authenticated video equivalent used by full galleries in web and Desktop. */
export function PreviewVideo({ preview, className }: { preview: PublishedVisualPreview; className: string }) {
  const source = usePreviewMediaSource(preview.url);
  if (source.status === 'loading') {
    return <span role="status" aria-label={`${preview.title} — video loading`} className={`${className} block animate-pulse bg-slate-900`} />;
  }
  if (source.status === 'failed') {
    return <span role="img" aria-label={`${preview.title} — video unavailable`} className={`${className} flex items-center justify-center bg-slate-900 text-sm text-white/70`}>
      <Film className="mr-2 h-5 w-5" />Video unavailable
    </span>;
  }
  return <video src={source.src} aria-label={preview.title} controls preload="metadata" playsInline className={className} />;
}

/** A 48×32 thumbnail for action rails; it removes itself when the image can't load rather than show a broken placeholder. */
function RailThumbnail({ preview }: { preview: PublishedVisualPreview }) {
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => setUnavailable(false), [preview.url]);
  if (unavailable) return null;
  return <span title={preview.title} className="block h-8 w-12 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-100">
    {preview.type === 'image'
      ? <PreviewImage preview={preview} compact className="h-full w-full object-contain" onUnavailable={() => setUnavailable(true)} />
      : <span role="img" aria-label={`Video preview: ${preview.title}`} className="flex h-full w-full items-center justify-center bg-slate-800 text-white"><Film className="h-3.5 w-3.5" /></span>}
  </span>;
}

/**
 * Non-interactive so it can live inside a task/goal/Inbox navigation target.
 * `micro` keeps dense list rows on their vertical rhythm with square 24px thumbnails;
 * `rail` sits beside action buttons and hides when its image is unavailable.
 */
export function PreviewThumbnails({ media, limit = 3, size = 'default' }: { media?: unknown; limit?: 1 | 3; size?: 'default' | 'micro' | 'rail' }) {
  const previews = trustedPreviewMedia(media, limit);
  if (!previews.length) return null;
  if (size === 'rail') {
    return <div role="group" aria-label="Published visual previews" className="flex flex-none gap-1 empty:hidden">
      {previews.map(preview => <RailThumbnail key={preview.url} preview={preview} />)}
    </div>;
  }
  const micro = size === 'micro';
  return <div role="group" aria-label="Published visual previews" className={micro ? 'flex max-w-full flex-none gap-1' : 'mt-2 flex max-w-full flex-wrap gap-1.5'}>
    {previews.map(preview => <span key={preview.url} title={preview.title} className={`block shrink-0 overflow-hidden border border-slate-200 bg-white ${micro ? 'h-6 w-6 rounded-sm' : 'w-16 rounded-md sm:w-20'}`}>
      {preview.type === 'image' ? <PreviewImage preview={preview} compact {...(micro ? { className: 'h-6 w-6 object-cover bg-slate-900/5' } : {})} />
        : <span role="img" aria-label={`Video preview: ${preview.title}`} className={`flex flex-col items-center justify-center bg-slate-800 text-white ${micro ? 'h-6 w-6' : 'h-12 gap-0.5 sm:h-14'}`}><Film className={micro ? 'h-3 w-3' : 'h-4 w-4'} />{!micro && <span className="text-[10px]">Video preview</span>}</span>}
    </span>)}
  </div>;
}
