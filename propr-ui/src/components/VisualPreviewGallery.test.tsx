import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublishedVisualPreview } from '@propr/shared';
import VisualPreviewGallery from './VisualPreviewGallery';

const preview = (title: string): PublishedVisualPreview =>
  ({ type: 'image', title, url: `https://github.com/user-attachments/assets/${title.toLowerCase()}` });

const both = [preview('Desktop'), preview('Mobile')];
const open = (title: string) => fireEvent.click(screen.getByRole('button', { name: `Open full-size preview: ${title}` }));
afterEach(() => vi.restoreAllMocks());

describe('VisualPreviewGallery', () => {
  it('keeps authenticated application media inside the gallery instead of exposing a broken renderer link', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    const secured = { ...preview('Private'), url: '/api/preview-media/pulls/acme/web/42/private' };
    render(<VisualPreviewGallery previews={[secured]} />);
    expect(screen.getByRole('button', { name: 'Open full-size preview: Private' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open original: Private' })).toBeNull();
  });

  it('keeps the open preview when a refresh reorders the list', () => {
    const { rerender } = render(<VisualPreviewGallery previews={both} />);
    open('Mobile');
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Mobile');
    rerender(<VisualPreviewGallery previews={[both[1], both[0]]} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Mobile');
  });

  it('closes for good once the open preview disappears from a refresh', () => {
    const { rerender } = render(<VisualPreviewGallery previews={both} />);
    open('Mobile');
    rerender(<VisualPreviewGallery previews={[both[0]]} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    // A later refresh that brings the preview back must not reopen the lightbox unasked.
    rerender(<VisualPreviewGallery previews={both} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
