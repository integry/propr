import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { ArrowUpRight, Film, Image as ImageIcon, Maximize2, Monitor, Smartphone, Tablet } from 'lucide-react';
import { trustedApplicationPreviewMediaUrl, trustedPreviewMedia, type PublishedVisualPreview } from '@propr/shared';
import { PreviewImage, PreviewVideo } from '../PreviewMedia';
import PreviewLightbox from '../PreviewLightbox';

type DeviceKind = 'desktop' | 'tablet' | 'mobile';
type ZoomMode = 'fit' | 'actual';

/** The width a capture was taken at, when its title or description says, e.g. `1920`. */
function captureWidth(preview: PublishedVisualPreview): string | null {
  const text = `${preview.title} ${preview.description ?? ''}`;
  return text.match(/\b(\d{3,4})\s*(?:px\b|[x×]\s*\d{3,4})/i)?.[1] ?? null;
}

/** The device class a capture was taken on: named in its title or description, or implied by its width. */
function captureDevice(preview: PublishedVisualPreview): DeviceKind | null {
  const text = `${preview.title} ${preview.description ?? ''}`;
  const named = text.match(/\b(desktop|tablet|mobile)\b/i)?.[1]?.toLowerCase() as DeviceKind | undefined;
  if (named) return named;
  const width = Number(captureWidth(preview));
  if (!width) return null;
  return width < 640 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop';
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

/** A short name for a capture in the switcher: a before/after side, its viewport, or its own title. */
function captureLabel(preview: PublishedVisualPreview): string {
  const side = preview.title.match(/\b(before|after)\b/i)?.[1];
  if (side) return side[0].toUpperCase() + side.slice(1).toLowerCase();
  return captureViewport(preview) ?? preview.title;
}

/** Captures whose title reports a failure are flagged in the switcher; naming an assertion alone is not a failure. */
const isFailureCapture = (preview: PublishedVisualPreview) => /\bfail(?:s|ed|ing|ure)?\b/i.test(preview.title);

function CaptureIcon({ preview }: { preview: PublishedVisualPreview }) {
  const device = captureDevice(preview);
  const Icon = preview.type === 'video' ? Film : device ? { desktop: Monitor, tablet: Tablet, mobile: Smartphone }[device] : ImageIcon;
  return <Icon className="h-3 w-3 flex-none" aria-hidden="true" />;
}

const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500';
const segment = `inline-flex h-6 items-center rounded px-1.5 transition-colors ${focusRing}`;
// A faint checkerboard tells transparent pixels and white page edges apart from the stage itself.
const checkerboard: CSSProperties = {
  backgroundColor: 'rgb(241 245 249)',
  backgroundImage: 'conic-gradient(rgb(226 232 240) 25%, transparent 0 50%, rgb(226 232 240) 0 75%, transparent 0)',
  backgroundSize: '16px 16px',
};

/** Numbered capture chips with their device; a capture that reports a failure is tinted red. */
function CaptureSwitcher({ media, selected, onSelect }: {
  media: PublishedVisualPreview[]; selected: PublishedVisualPreview; onSelect: (url: string) => void;
}) {
  return <div role="group" aria-label="Captures" className="flex min-w-0 flex-wrap gap-0.5 rounded bg-slate-200/60 p-0.5">
    {media.map((preview, index) => {
      const active = preview === selected;
      const failure = isFailureCapture(preview);
      const tone = failure
        ? `border-red-300 bg-red-50 text-red-700 ${active ? 'shadow-sm ring-1 ring-red-300' : 'hover:bg-red-100'}`
        : active ? 'border-transparent bg-white font-semibold text-slate-900 shadow-sm' : 'border-transparent text-slate-600 hover:text-slate-900';
      return <button key={preview.url} type="button" aria-pressed={active} title={preview.title}
        onClick={() => onSelect(preview.url)}
        className={`inline-flex h-6 max-w-[13rem] items-center gap-1 rounded border px-1.5 text-xs font-medium transition-colors ${focusRing} ${tone}`}>
        <CaptureIcon preview={preview} />
        <span aria-hidden="true" className={`font-mono text-[10px] ${failure ? 'text-red-500' : 'text-slate-400'}`}>{String(index + 1).padStart(2, '0')}</span>
        <span className="truncate">{captureLabel(preview)}</span>
      </button>;
    })}
  </div>;
}

/** Fit scales the whole capture into the stage; 100% shows its real pixels. */
function ZoomToggle({ mode, onChange }: { mode: ZoomMode; onChange: (mode: ZoomMode) => void }) {
  const option = (value: ZoomMode, label: string, title: string) => <button type="button" aria-pressed={mode === value} title={title} onClick={() => onChange(value)}
    className={`${segment} ${mode === value ? 'bg-white font-bold text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>;
  return <div role="group" aria-label="Zoom" className="flex items-center rounded border border-slate-200 bg-slate-100 p-0.5 font-mono text-[11px]">
    {option('fit', 'Fit', 'Fit the whole capture in the stage')}
    {option('actual', '100%', 'Show the capture at its real pixel size')}
  </div>;
}

/** The selected capture's own resolution, e.g. `1440×900`, read from the media once it loads. */
function useCapturedSize(stageRef: RefObject<HTMLDivElement | null>, url: string | undefined): string | null {
  const [natural, setNatural] = useState<{ url: string; size: string } | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !url) return;
    const measure = () => {
      const element = stage.querySelector('img, video');
      const [width, height] = element instanceof HTMLImageElement ? [element.naturalWidth, element.naturalHeight]
        : element instanceof HTMLVideoElement ? [element.videoWidth, element.videoHeight] : [0, 0];
      if (width && height) setNatural({ url, size: `${width}×${height}` });
    };
    measure();
    // Load events don't bubble, so the stage listens for them in the capture phase.
    stage.addEventListener('load', measure, true);
    stage.addEventListener('loadedmetadata', measure, true);
    return () => {
      stage.removeEventListener('load', measure, true);
      stage.removeEventListener('loadedmetadata', measure, true);
    };
  }, [stageRef, url]);
  return natural && natural.url === url ? natural.size : null;
}

/** One or two lines on what the capture shows, with its viewport, resolution and kind. */
function ContextStrip({ preview, dimensions }: { preview: PublishedVisualPreview; dimensions: string | null }) {
  const viewport = captureViewport(preview);
  return <figcaption data-testid="visual-evidence-context" className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-1.5 text-xs">
    <p className="m-0 min-w-0 flex-1 basis-64 break-words leading-5">
      <span className="font-semibold text-slate-900">{preview.title}</span>
      {preview.description && <>
        <span aria-hidden="true" className="text-slate-400"> — </span>
        <span className="whitespace-pre-line text-slate-600">{preview.description}</span>
      </>}
    </p>
    <span className="flex flex-none flex-wrap items-center gap-1.5 font-mono text-[11px] text-slate-500">
      {viewport && <span>{viewport}</span>}
      {dimensions && <span data-testid="visual-evidence-dimensions" className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{dimensions}</span>}
      <span>{preview.type === 'image' ? 'Screenshot' : 'Video'}</span>
    </span>
  </figcaption>;
}

/**
 * Visual evidence published by this specific task run, stacked for inspection: a header with the
 * capture switcher and Fit/100% controls, a one-line context strip, and an imaging stage
 * that shows the whole capture (Fit) or its pixels 1:1 in a scrollable pane (100%).
 * Renders nothing when the run published none.
 */
export default function TaskVisualPreviews({ previews, className = 'border-b border-slate-200 px-4 py-3' }: {
  previews?: PublishedVisualPreview[];
  /** The section's frame; the task pane rules it off from the trace below. */
  className?: string;
}) {
  const media = trustedPreviewMedia(previews, 8);
  // Tracked by url, not index: polling refreshes reorder and replace the list.
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit');
  const opener = useRef<HTMLButtonElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const selected = media.find(preview => preview.url === selectedUrl) ?? media[0];
  // Videos keep their native controls on the stage; only images form the lightbox sequence.
  const images = media.filter(preview => preview.type === 'image');
  const lightboxIndex = lightboxUrl === null ? -1 : images.findIndex(image => image.url === lightboxUrl);
  useEffect(() => {
    if (lightboxUrl !== null && lightboxIndex < 0) setLightboxUrl(null);
  }, [lightboxUrl, lightboxIndex]);

  const dimensions = useCapturedSize(stageRef, selected?.url);
  if (!selected) return null;

  const openLightbox = (trigger: HTMLButtonElement) => {
    opener.current = trigger;
    setLightboxUrl(selected.url);
  };
  const isImage = selected.type === 'image';
  const actual = isImage && zoomMode === 'actual';

  return <section aria-labelledby="task-visual-previews-heading" className={className}>
    <div data-testid="visual-evidence-header" className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-2">
      <h2 id="task-visual-previews-heading" className="m-0 text-[11px] font-bold uppercase tracking-widest text-slate-500">
        Visual evidence{' '}
        <span className="ml-1.5 font-mono font-normal normal-case tracking-normal">({media.length} {media.length === 1 ? 'capture' : 'captures'})</span>
      </h2>
      {media.length > 1 && <CaptureSwitcher media={media} selected={selected} onSelect={setSelectedUrl} />}
      <div className="ml-auto flex flex-none items-center gap-1 text-xs">
        {isImage && <ZoomToggle mode={zoomMode} onChange={setZoomMode} />}
        {isImage && (
          <button type="button" aria-haspopup="dialog" aria-label="Lightbox" title="Open in the lightbox" onClick={event => openLightbox(event.currentTarget)}
            className={`inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 ${focusRing}`}>
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        {!trustedApplicationPreviewMediaUrl(selected.url) && <a href={selected.url} target="_blank" rel="noopener noreferrer" aria-label={`Open original: ${selected.title}`} title="Open full resolution in a new tab"
          className={`inline-flex h-7 w-7 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 ${focusRing}`}>
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </a>}
      </div>
    </div>

    <figure className="m-0 mt-2 min-w-0 border border-slate-200 bg-white">
      <ContextStrip preview={selected} dimensions={dimensions} />
      {/* Fit follows the image's intrinsic ratio; only actual-size images and videos use a fixed stage. */}
      <div ref={stageRef} data-testid="visual-evidence-canvas" data-zoom={actual ? 'actual' : 'fit'} style={checkerboard}
        className={isImage && !actual ? 'mx-auto flex w-fit max-w-full justify-center'
          : `h-80 w-full sm:h-[440px] ${actual ? 'overflow-auto p-3' : 'flex items-center justify-center p-2'}`}>
        {!isImage
          ? <PreviewVideo key={selected.url} preview={selected} className="max-h-full max-w-full bg-slate-900" />
          // One tree for both modes, so toggling zoom restyles the loaded image instead of fetching it again.
          : <button type="button" aria-haspopup="dialog" aria-label={`Open full-size preview: ${selected.title}`}
            onClick={event => openLightbox(event.currentTarget)}
            className={`cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${actual ? 'block w-max focus-visible:ring-inset' : 'flex min-w-0 max-w-full items-center justify-center [&>span]:min-h-16 [&>span]:min-w-32'}`}>
            {/* Placeholder spans need their own size before an image has intrinsic dimensions. */}
            <PreviewImage key={selected.url} preview={selected} className={actual
              ? 'block h-auto w-auto max-w-none border border-slate-200/80 bg-white'
              : 'block h-auto w-auto max-h-80 max-w-full object-contain sm:max-h-[440px]'} />
          </button>}
      </div>
    </figure>

    {lightboxIndex >= 0 && <PreviewLightbox previews={images} index={lightboxIndex} onIndexChange={index => { setLightboxUrl(images[index]?.url ?? null); setSelectedUrl(images[index]?.url ?? null); }}
      onClose={() => setLightboxUrl(null)} returnFocusTo={opener.current} />}
  </section>;
}
