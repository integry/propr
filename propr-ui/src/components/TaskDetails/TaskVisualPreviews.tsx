import { trustedPreviewMedia, type PublishedVisualPreview } from '@propr/shared';
import VisualPreviewGallery from '../VisualPreviewGallery';

/** Visual evidence published by this specific task run. Renders nothing when the run published none. */
export default function TaskVisualPreviews({ previews }: { previews?: PublishedVisualPreview[] }) {
  const media = trustedPreviewMedia(previews, 8);
  if (!media.length) return null;
  return <section aria-labelledby="task-visual-previews-heading" className="border-b border-slate-200 px-4 py-4">
    <h2 id="task-visual-previews-heading" className="text-sm font-semibold text-slate-900">Visual Previews</h2>
    <VisualPreviewGallery previews={media} className="mt-3" />
  </section>;
}
