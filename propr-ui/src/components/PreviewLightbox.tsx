import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Film, ImageOff, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { PublishedVisualPreview } from '@propr/shared';
import { MAX_ZOOM, MIN_ZOOM, useLightboxZoom } from './useLightboxZoom';
import { usePreviewMediaSource } from './usePreviewMediaSource';

// `video[controls]` is a tab stop of its own, so it has to take part in the trap's cycle.
const FOCUSABLE = 'button:not([disabled]), a[href], video[controls], [tabindex]:not([tabindex="-1"])';
const control = 'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white/90 hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 disabled:opacity-40 disabled:hover:bg-transparent';
const navControl = 'absolute top-1/2 z-10 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-slate-900/70 text-white shadow-lg hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400';

interface PreviewLightboxProps {
  /** Images and videos; callers pass media that already passed `trustedPreviewMedia`. */
  previews: PublishedVisualPreview[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Focus target restored on close — the preview button that opened the lightbox. */
  returnFocusTo?: HTMLElement | null;
}

/**
 * Full-screen, screen-capped media viewer with gallery navigation. Images get pinch/wheel zoom and pan;
 * videos play inline with their native controls, so the stage leaves their gestures and keys alone.
 */
export default function PreviewLightbox({ previews, index, onIndexChange, onClose, returnFocusTo }: PreviewLightboxProps) {
  const preview = previews[index];
  const total = previews.length;
  const isVideo = preview?.type === 'video';
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const source = usePreviewMediaSource(preview?.url ?? '');
  const zoom = useLightboxZoom({ stageRef, contentRef: imageRef, resetKey: preview?.url });
  const { onWheel } = zoom;

  const go = useCallback((step: number) => {
    if (total > 1) onIndexChange((index + step + total) % total);
  }, [index, onIndexChange, total]);

  useEffect(() => {
    closeRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    // Guard focus at the document boundary: app-level shortcuts (e.g. Ctrl/Cmd+K) can focus background
    // content directly, after which the dialog's own handlers would no longer see keyboard events.
    let lastInside: HTMLElement | null = closeRef.current;
    const handleFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      const target = event.target as HTMLElement;
      if (!dialog || dialog.contains(target)) {
        lastInside = target;
        return;
      }
      const restore = lastInside?.isConnected && lastInside.matches(FOCUSABLE) ? lastInside : closeRef.current;
      restore?.focus();
    };
    const handleTab = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !focusable.includes(active as HTMLElement);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('keydown', handleTab, true);
    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('keydown', handleTab, true);
      document.body.style.overflow = overflow;
      returnFocusTo?.focus();
    };
  }, [returnFocusTo]);

  // A render can take the focused control with it: navigating between media drops the zoom buttons, those
  // buttons disable themselves at their bounds, and a failed load replaces the player. Removing or disabling
  // the active element leaves focus on the body without firing `focusin`, so the boundary guard above never
  // sees it and the dialog's Escape and arrow keys stop reaching a handler. Focus that is still inside stays put.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) closeRef.current?.focus();
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || isVideo) return;
    // React registers wheel listeners as passive, so preventDefault needs a native listener.
    dialog.addEventListener('wheel', onWheel, { passive: false });
    return () => dialog.removeEventListener('wheel', onWheel);
  }, [isVideo, onWheel]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A focused video owns the arrow keys for seeking; gallery navigation stays on every other target.
    const seeking = (event.target as HTMLElement).tagName === 'VIDEO';
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (seeking) return;
      event.preventDefault();
      go(event.key === 'ArrowLeft' ? -1 : 1);
    } else if (isVideo) {
      // Zoom shortcuts have no meaning for a video, and Space/digits belong to its controls.
    } else if (event.key === '+' || event.key === '=') {
      zoom.zoomIn();
    } else if (event.key === '-') {
      zoom.zoomOut();
    } else if (event.key === '0') {
      zoom.reset();
    }
  };

  const handleStageClick = (event: MouseEvent<HTMLDivElement>) => {
    // A click that ends a pan or pinch is not a dismissal, wherever it lands.
    if (!isVideo && zoom.consumeGestureClick()) return;
    if (event.target === event.currentTarget) onClose();
  };

  if (!preview) return null;
  const { scale } = zoom.view;
  const percent = Math.round(scale * 100);
  const failed = failedUrl === preview.url || source.status === 'failed';

  return createPortal(
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleKeyDown}
      data-testid="preview-lightbox" className="fixed inset-0 z-[70] flex flex-col overflow-hidden bg-slate-950 text-white outline-none">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-2 py-1.5 sm:gap-2 sm:px-4">
        <p id={titleId} className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{preview.title}</p>
        {total > 1 && <span aria-live="polite" className="shrink-0 px-1 text-xs tabular-nums text-white/70">{index + 1} / {total}</span>}
        {!isVideo && <>
          <button type="button" onClick={zoom.zoomOut} disabled={scale <= MIN_ZOOM} aria-label="Zoom out" className={control}>
            <ZoomOut className="h-5 w-5" aria-hidden="true" />
          </button>
          <button type="button" onClick={zoom.reset} aria-label={`Reset zoom (currently ${percent}%)`}
            className={`${control} w-auto min-w-10 px-2 text-xs font-semibold tabular-nums`}>
            {percent}%
          </button>
          <button type="button" onClick={zoom.zoomIn} disabled={scale >= MAX_ZOOM} aria-label="Zoom in" className={control}>
            <ZoomIn className="h-5 w-5" aria-hidden="true" />
          </button>
        </>}
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close preview" className={control}>
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      <div ref={stageRef} data-testid="preview-lightbox-stage" onClick={handleStageClick} {...(isVideo ? {} : zoom.handlers)}
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2 sm:p-6${isVideo ? '' : ' touch-none select-none'}`}>
        {failed
          ? <span role="img" aria-label={`${preview.title} — ${isVideo ? 'video' : 'image'} unavailable`} className="flex flex-col items-center gap-2 text-sm text-white/70">
            {isVideo ? <Film className="h-8 w-8" aria-hidden="true" /> : <ImageOff className="h-8 w-8" aria-hidden="true" />}
            {isVideo ? 'Video unavailable' : 'Image unavailable'}
          </span>
          : source.status === 'loading'
            ? <span role="status" className="text-sm text-white/70">Loading preview…</span>
          : isVideo
            ? <video key={source.src} src={source.src} aria-label={preview.title} controls playsInline preload="metadata"
              onError={() => setFailedUrl(preview.url)} className="max-h-full max-w-full bg-black object-contain" />
          : <img ref={imageRef} key={source.src} src={source.src} alt={preview.title} draggable={false} onError={() => setFailedUrl(preview.url)}
            style={{ transform: zoom.transform }}
            className={`max-h-full max-w-full origin-center object-contain will-change-transform ${scale > MIN_ZOOM ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'}`} />}
        {total > 1 && <>
          <button type="button" onClick={() => go(-1)} aria-label="Previous preview" className={`${navControl} left-2 sm:left-4`}>
            <ChevronLeft className="h-6 w-6" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => go(1)} aria-label="Next preview" className={`${navControl} right-2 sm:right-4`}>
            <ChevronRight className="h-6 w-6" aria-hidden="true" />
          </button>
        </>}
      </div>
    </div>,
    document.body,
  );
}
