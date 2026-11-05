import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import type { PublishedVisualPreview } from '@propr/shared';
import { getRepositoryMedia } from '../../api/repositoryMediaApi';
import { PreviewImage, PreviewVideo } from '../PreviewMedia';
import PreviewLightbox from '../PreviewLightbox';

export default function RepoMediaPanel({ repository }: { repository: string }) {
  const [previews, setPreviews] = useState<PublishedVisualPreview[]>([]);
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  // The open item is tracked by url, not index: paging in more media reorders nothing, but a dropped
  // item would otherwise slide a different preview under the reader.
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const openIndex = openUrl === null ? -1 : previews.findIndex(preview => preview.url === openUrl);
  useEffect(() => {
    if (openUrl !== null && openIndex < 0) setOpenUrl(null);
  }, [openUrl, openIndex]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setUnavailable(false);
    getRepositoryMedia(repository, offset).then(data => {
      if (!active) return;
      setPreviews(previous => [...new Map([...previous, ...data.previews].map(preview => [preview.url, preview])).values()]);
      setNextOffset(data.nextOffset);
      setUnavailable(data.unavailable);
    }).catch(() => { if (active) setUnavailable(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [repository, offset, retry]);

  return <section aria-label={`Published media for ${repository}`} className="h-full overflow-y-auto p-4 sm:p-6">
    <h2 className="text-base font-semibold text-slate-900">Media</h2>
    <p className="mt-1 text-sm text-slate-500">Published visual previews from tasks and goals in {repository}.</p>
    {unavailable && <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      Some media is unavailable. <button type="button" onClick={() => setRetry(value => value + 1)} className="min-h-10 font-semibold underline">Try again</button>
    </div>}
    {!loading && !unavailable && !previews.length && <div role="status" className="mt-6 rounded-xl border border-dashed border-slate-300 p-8 text-center">
      <p className="font-medium text-slate-700">{nextOffset === null ? 'No published previews yet' : 'No previews in these tasks and goals'}</p>
      <p className="mt-1 text-sm text-slate-500">Media appears here after a task or goal publishes visual evidence to GitHub.</p>
    </div>}
    <div className="mt-5 grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-4">
      {previews.map(preview => <figure key={preview.url} className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <button type="button" aria-haspopup="dialog" aria-label={`Open preview: ${preview.title}`}
          onClick={event => { opener.current = event.currentTarget; setOpenUrl(preview.url); }}
          className={`relative block w-full bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500 ${preview.type === 'image' ? 'cursor-zoom-in' : 'cursor-pointer'}`}>
          {preview.type === 'image'
            ? <PreviewImage preview={preview} />
            : <>
              <PreviewVideo preview={preview} controls={false} className="aspect-video w-full bg-slate-950 object-contain" />
              <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-900/70 text-white shadow-lg"><Play className="h-6 w-6" /></span>
              </span>
            </>}
        </button>
        <figcaption className="p-3"><p className="break-words text-sm font-medium text-slate-800">{preview.title}</p>
          {preview.description && <p className="mt-1 break-words text-xs leading-5 text-slate-500">{preview.description}</p>}
        </figcaption>
      </figure>)}
    </div>
    {loading && <p role="status" className="py-8 text-center text-sm text-slate-500">Loading media…</p>}
    {!loading && nextOffset !== null && <button type="button" onClick={() => setOffset(nextOffset)} className="mt-5 min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700">Load more media</button>}
    {openIndex >= 0 && <PreviewLightbox previews={previews} index={openIndex} onIndexChange={index => setOpenUrl(previews[index]?.url ?? null)}
      onClose={() => setOpenUrl(null)} returnFocusTo={opener.current} />}
  </section>;
}
