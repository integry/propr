import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PublishedVisualPreview } from '@propr/shared';
import VisualPreviewGallery from './VisualPreviewGallery';

const preview = (title: string): PublishedVisualPreview =>
  ({ type: 'image', title, url: `https://github.com/user-attachments/assets/${title.toLowerCase()}` });

const both = [preview('Desktop'), preview('Mobile')];
const open = (title: string) => fireEvent.click(screen.getByRole('button', { name: `Open full-size preview: ${title}` }));

describe('VisualPreviewGallery', () => {
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
