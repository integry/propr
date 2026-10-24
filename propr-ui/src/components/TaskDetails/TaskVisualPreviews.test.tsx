import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskVisualPreviews from './TaskVisualPreviews';

const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;

describe('TaskVisualPreviews', () => {
  it('stacks the context strip over an intrinsically sized frame that fits the whole capture', () => {
    const { container } = render(<TaskVisualPreviews previews={[
      { type: 'image', title: 'Task list at Desktop 1920px', description: 'Row keeps its full title', url: asset('image') },
      { type: 'video', title: 'Checkout flow', url: asset('video') },
      { type: 'image', title: 'Untrusted', url: 'https://evil.test/image.png' },
    ]} />);
    expect(screen.getByRole('heading', { name: 'Visual evidence (2 captures)' })).toBeInTheDocument();
    const stage = screen.getByTestId('visual-evidence-canvas');
    expect(stage).toHaveClass('w-fit', 'max-w-full', 'justify-center');
    expect(stage).not.toHaveClass('h-80', 'sm:h-[440px]', 'p-2');
    expect(stage).toHaveAttribute('data-zoom', 'fit');
    const image = screen.getByAltText('Task list at Desktop 1920px');
    expect(image).toHaveAttribute('src', asset('image'));
    // Fit never clips: the whole capture is scaled into the stage.
    expect(image).toHaveClass('h-auto', 'w-auto', 'max-h-80', 'sm:max-h-[440px]', 'max-w-full', 'object-contain');
    expect(image).not.toHaveClass('min-h-16', 'min-w-32', 'bg-white');
    expect(image).not.toHaveClass('object-cover');
    const context = screen.getByTestId('visual-evidence-context');
    expect(within(context).getByText('Row keeps its full title')).toBeInTheDocument();
    expect(within(context).getByText('Desktop 1920px')).toBeInTheDocument();
    expect(within(context).getByText('Screenshot')).toBeInTheDocument();
    // No faux browser window around the capture.
    expect(screen.queryByTestId('visual-evidence-window')).toBeNull();
    expect(container.querySelectorAll('.rounded-full')).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Open original: Task list at Desktop 1920px' })).toHaveAttribute('href', asset('image'));
    // Only the selected capture is on screen: the video waits behind the switcher.
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByText('Untrusted')).toBeNull();
    expect(container.querySelector('img[src="https://evil.test/image.png"]')).toBeNull();
  });

  it('shows the capture at its real pixel size in a scrollable stage at 100%', () => {
    render(<TaskVisualPreviews previews={[{ type: 'image', title: 'Tall mobile page', url: asset('tall') }]} />);
    const zoom = screen.getByRole('group', { name: 'Zoom' });
    expect(within(zoom).getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(zoom).getByRole('button', { name: '100%' }));
    expect(within(zoom).getByRole('button', { name: '100%' })).toHaveAttribute('aria-pressed', 'true');
    const stage = screen.getByTestId('visual-evidence-canvas');
    expect(stage).toHaveAttribute('data-zoom', 'actual');
    expect(stage).toHaveClass('overflow-auto', 'h-80', 'sm:h-[440px]', 'w-full');
    expect(screen.getByAltText('Tall mobile page')).toHaveClass('max-w-none', 'h-auto', 'w-auto');
  });

  it('reports the captured resolution once the image loads', () => {
    render(<TaskVisualPreviews previews={[{ type: 'image', title: 'Dialog', url: asset('dialog') }]} />);
    const image = screen.getByAltText('Dialog');
    Object.defineProperty(image, 'naturalWidth', { value: 1440 });
    Object.defineProperty(image, 'naturalHeight', { value: 900 });
    fireEvent.load(image);
    expect(screen.getByTestId('visual-evidence-dimensions')).toHaveTextContent('1440×900');
  });

  it('numbers captures in the switcher, marks their device and flags failed ones', () => {
    render(<TaskVisualPreviews previews={[
      { type: 'image', title: 'Chart at desktop 1440px', url: asset('a') },
      { type: 'image', title: 'Assertion failed at 390px', url: asset('b') },
      { type: 'image', title: 'Checkout assertion passed', url: asset('c') },
    ]} />);
    const switcher = screen.getByRole('group', { name: 'Captures' });
    expect(within(switcher).getAllByRole('button').map(button => button.textContent)).toEqual(['01Desktop 1440px', '02390px', '03Checkout assertion passed']);
    expect(within(switcher).getByRole('button', { name: '390px' })).toHaveClass('border-red-300', 'text-red-700', 'bg-red-50');
    expect(within(switcher).getByRole('button', { name: 'Desktop 1440px' })).not.toHaveClass('border-red-300');
    const passed = within(switcher).getByRole('button', { name: 'Checkout assertion passed' });
    expect(passed).not.toHaveClass('border-red-300', 'text-red-700', 'bg-red-50');
    expect(passed).toHaveClass('border-transparent', 'text-slate-600');
  });

  it('switches captures in place and plays videos with their controls', () => {
    const { container } = render(<TaskVisualPreviews previews={[
      { type: 'image', title: 'Before the fix', url: asset('before') },
      { type: 'image', title: 'After the fix on mobile 390px', url: asset('after') },
      { type: 'video', title: 'Walkthrough', url: asset('video') },
    ]} />);
    const switcher = screen.getByRole('group', { name: 'Captures' });
    expect(within(switcher).getAllByRole('button').map(button => button.textContent)).toEqual(['01Before', '02After', '03Walkthrough']);
    expect(within(switcher).getByRole('button', { name: 'Before' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(switcher).getByRole('button', { name: 'After' }));
    expect(screen.getByAltText('After the fix on mobile 390px')).toBeInTheDocument();
    expect(screen.queryByAltText('Before the fix')).toBeNull();
    expect(screen.getByText('Mobile 390px')).toBeInTheDocument();

    fireEvent.click(within(switcher).getByRole('button', { name: 'Walkthrough' }));
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', asset('video'));
    expect(video).toHaveAttribute('controls');
    expect(screen.queryByRole('button', { name: 'Lightbox' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Zoom' })).toBeNull();
  });

  it('opens images in an in-app lightbox, skips videos, and restores focus on close', () => {
    render(<TaskVisualPreviews previews={[
      { type: 'image', title: 'First', url: asset('first') },
      { type: 'video', title: 'Walkthrough', url: asset('video') },
      { type: 'image', title: 'Second', url: asset('second') },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
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
    expect(screen.getByRole('button', { name: 'First' })).toHaveAttribute('aria-pressed', 'true');
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
