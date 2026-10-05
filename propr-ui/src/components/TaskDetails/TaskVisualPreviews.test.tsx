import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskVisualPreviews from './TaskVisualPreviews';

const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;

describe('TaskVisualPreviews', () => {
  it('frames one capture at a time beside its title, description and viewport', () => {
    const { container } = render(<TaskVisualPreviews previews={[
      { type: 'image', title: 'Task list at Desktop 1920px', description: 'Row keeps its full title', url: asset('image') },
      { type: 'video', title: 'Checkout flow', url: asset('video') },
      { type: 'image', title: 'Untrusted', url: 'https://evil.test/image.png' },
    ]} />);
    expect(screen.getByRole('heading', { name: 'Visual evidence (2 captures)' })).toBeInTheDocument();
    const canvas = screen.getByTestId('visual-evidence-canvas');
    expect(canvas).toHaveClass('sm:h-56', 'sm:flex-row');
    const image = screen.getByAltText('Task list at Desktop 1920px');
    expect(image).toHaveAttribute('src', asset('image'));
    expect(image).toHaveClass('h-full', 'w-full', 'object-cover', 'object-left-top');
    expect(within(canvas).getByText('Row keeps its full title')).toBeInTheDocument();
    expect(within(canvas).getByText('Desktop 1920px')).toBeInTheDocument();
    expect(screen.getByText('Click to inspect full resolution')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open original: Task list at Desktop 1920px' })).toHaveAttribute('href', asset('image'));
    // Only the selected capture is on screen: the video waits behind the switcher.
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByText('Untrusted')).toBeNull();
    expect(container.querySelector('img[src="https://evil.test/image.png"]')).toBeNull();
  });

  it('switches captures in place and plays videos with their controls', () => {
    const { container } = render(<TaskVisualPreviews previews={[
      { type: 'image', title: 'Before the fix', url: asset('before') },
      { type: 'image', title: 'After the fix on mobile 390px', url: asset('after') },
      { type: 'video', title: 'Walkthrough', url: asset('video') },
    ]} />);
    const switcher = screen.getByRole('group', { name: 'Captures' });
    expect(within(switcher).getAllByRole('button').map(button => button.textContent)).toEqual(['Before', 'After', 'Capture 3']);
    expect(within(switcher).getByRole('button', { name: 'Before' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(switcher).getByRole('button', { name: 'After' }));
    expect(screen.getByAltText('After the fix on mobile 390px')).toBeInTheDocument();
    expect(screen.queryByAltText('Before the fix')).toBeNull();
    expect(screen.getByText('Mobile 390px')).toBeInTheDocument();

    fireEvent.click(within(switcher).getByRole('button', { name: 'Capture 3' }));
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', asset('video'));
    expect(video).toHaveAttribute('controls');
    expect(screen.queryByRole('button', { name: 'Lightbox' })).toBeNull();
  });

  it('opens images in an in-app lightbox, skips videos, and restores focus on close', () => {
    render(<TaskVisualPreviews previews={[
      { type: 'image', title: 'First', url: asset('first') },
      { type: 'video', title: 'Walkthrough', url: asset('video') },
      { type: 'image', title: 'Second', url: asset('second') },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture 3' }));
    const trigger = screen.getByRole('button', { name: 'Open full-size preview: Second' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Second' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.parentElement).toBe(document.body);
    expect(within(dialog).getByText('2 / 2')).toBeInTheDocument();
    expect(within(dialog).getByAltText('Second')).toHaveAttribute('src', asset('second'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next preview' }));
    expect(screen.getByRole('dialog', { name: 'First' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
    // The canvas follows the capture the lightbox was left on.
    expect(screen.getByRole('button', { name: 'Capture 1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens the lightbox from the header button too', () => {
    render(<TaskVisualPreviews previews={[{ type: 'image', title: 'Only', url: asset('only') }]} />);
    expect(screen.getByRole('heading', { name: 'Visual evidence (1 capture)' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Captures' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lightbox' }));
    expect(screen.getByRole('dialog', { name: 'Only' })).toBeInTheDocument();
  });

  it('renders nothing for runs without published previews', () => {
    expect(render(<TaskVisualPreviews />).container).toBeEmptyDOMElement();
    expect(render(<TaskVisualPreviews previews={[]} />).container).toBeEmptyDOMElement();
  });
});
