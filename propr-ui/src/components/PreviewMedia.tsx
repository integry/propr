import { useCallback, useEffect, useRef, useState } from 'react';
import { Film, ImageOff } from 'lucide-react';
import { trustedPreviewMedia, type PublishedVisualPreview } from '@propr/shared';
import { downsampleToCanvas, previewPixelRatio } from './previewDownsampling';
import { cacheCanvasPreview, getCachedPreview, getPreviewCacheKey, renderCachedPreview } from './previewCache';

/** Cache reads are asynchronous, so confirm the element still holds the preview the read was started for. */
const showsPreview = (image: HTMLImageElement | null, url: string) => image?.getAttribute('src') === url;

/** `className` replaces the default sizing classes; compact thumbnails keep their canvas downsampling either way. */
export function PreviewImage({ preview, compact = false, className: sizing }: { preview: PublishedVisualPreview; compact?: boolean; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [downsampled, setDownsampled] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // What the canvas currently shows, so the lazy `<img>` finishing later does
  // not repeat a downsample the cache already satisfied at this size.
  const renderedSizeRef = useRef<{ url: string; width: number; height: number } | null>(null);
  const className = sizing ?? (compact ? 'h-12 w-full object-contain bg-slate-900/5 sm:h-14' : 'aspect-video w-full object-contain');

  /** Paints last session's thumbnail without waiting on the full-resolution source. */
  const renderFromCache = useCallback(async (width: number, height: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const cached = await getCachedPreview(getPreviewCacheKey(preview.url, width, height, previewPixelRatio()));
    // Bail out if the component unmounted or moved to another preview while we were reading storage.
    if (!cached || canvasRef.current !== canvas || !showsPreview(imageRef.current, preview.url)) return false;
    if (!await renderCachedPreview(canvas, cached)) return false;
    renderedSizeRef.current = { url: preview.url, width, height };
    setDownsampled(true);
    return true;
  }, [preview.url]);

  const draw = useCallback(() => {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!compact || !image || !canvas) return;
    const width = image.clientWidth;
    const height = image.clientHeight;
    if (width <= 0 || height <= 0) return;
    const rendered = renderedSizeRef.current;
    if (rendered && rendered.url === preview.url && rendered.width === width && rendered.height === height) return;
    void renderFromCache(width, height).then(hit => {
      const source = imageRef.current;
      const target = canvasRef.current;
      if (hit || !source || !target || !showsPreview(source, preview.url) || !source.complete || !source.naturalWidth) return;
      try {
        const drawn = downsampleToCanvas(source, target, width, height);
        setDownsampled(drawn);
        if (!drawn) return;
        renderedSizeRef.current = { url: preview.url, width, height };
        void cacheCanvasPreview(preview.url, width, height, target);
      } catch {
        setDownsampled(false); // The native image remains a complete fallback.
      }
    });
  }, [compact, preview.url, renderFromCache]);

  useEffect(() => {
    setFailed(false);
    setDownsampled(false);
    renderedSizeRef.current = null;
  }, [preview.url]);

  useEffect(() => {
    const image = imageRef.current;
    if (!compact || failed || !image) return;
    // Once the layout box is known the cache can answer immediately, whether or
    // not the source image has downloaded yet.
    if (image.clientWidth > 0 && image.clientHeight > 0) draw();
    if (typeof ResizeObserver === 'undefined') return;
    // Thumbnail widths change at breakpoints; redraw for the new backing size.
    const observer = new ResizeObserver(() => draw());
    observer.observe(image);
    return () => observer.disconnect();
  }, [compact, draw, failed, preview.url]);

  if (failed) return <span role="img" aria-label={`${preview.title} — image unavailable`} className={`${className} flex items-center justify-center bg-slate-100 text-slate-500`}><ImageOff className="h-5 w-5" /></span>;
  const image = <img ref={imageRef} src={preview.url} alt={preview.title} loading="lazy" onLoad={draw} onError={() => setFailed(true)}
    className={`${className}${compact && downsampled ? ' opacity-0' : ''}`} />;
  if (!compact) return image;
  // The image stays in the DOM for lazy loading, accessibility and fallback; the canvas is presentation only.
  return <span className="relative block">
    {image}
    <canvas ref={canvasRef} aria-hidden="true" data-testid="preview-thumbnail-canvas"
      className={`pointer-events-none absolute inset-0 m-auto ${downsampled ? '' : 'hidden'}`} />
  </span>;
}

/**
 * Non-interactive so it can live inside a task/goal/Inbox navigation target.
 * `micro` keeps dense list rows on their vertical rhythm with square 24px thumbnails.
 */
export function PreviewThumbnails({ media, limit = 3, size = 'default' }: { media?: unknown; limit?: 1 | 3; size?: 'default' | 'micro' }) {
  const previews = trustedPreviewMedia(media, limit);
  if (!previews.length) return null;
  const micro = size === 'micro';
  return <div role="group" aria-label="Published visual previews" className={micro ? 'flex max-w-full flex-none gap-1' : 'mt-2 flex max-w-full flex-wrap gap-1.5'}>
    {previews.map(preview => <span key={preview.url} title={preview.title} className={`block shrink-0 overflow-hidden border border-slate-200 bg-white ${micro ? 'h-6 w-6 rounded-sm' : 'w-16 rounded-md sm:w-20'}`}>
      {preview.type === 'image' ? <PreviewImage preview={preview} compact {...(micro ? { className: 'h-6 w-6 object-cover bg-slate-900/5' } : {})} />
        : <span role="img" aria-label={`Video preview: ${preview.title}`} className={`flex flex-col items-center justify-center bg-slate-800 text-white ${micro ? 'h-6 w-6' : 'h-12 gap-0.5 sm:h-14'}`}><Film className={micro ? 'h-3 w-3' : 'h-4 w-4'} />{!micro && <span className="text-[10px]">Video preview</span>}</span>}
    </span>)}
  </div>;
}
