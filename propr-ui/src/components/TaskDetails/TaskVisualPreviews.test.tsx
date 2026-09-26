import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskVisualPreviews from './TaskVisualPreviews';

const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;

describe('TaskVisualPreviews', () => {
  it('renders images with originals, videos with controls, titles and descriptions', () => {
    const { container } = render(<TaskVisualPreviews previews={[
      { type: 'image', title: 'Settings dialog', description: 'Dialog at desktop width', url: asset('image') },
      { type: 'video', title: 'Checkout flow', url: asset('video') },
      { type: 'image', title: 'Untrusted', url: 'https://evil.test/image.png' },
    ]} />);
    expect(screen.getByRole('heading', { name: 'Visual Previews' })).toBeInTheDocument();
    expect(screen.getByAltText('Settings dialog')).toHaveAttribute('src', asset('image'));
    expect(screen.getByText('Dialog at desktop width')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Open full-size preview: Settings dialog' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).not.toHaveAttribute('href');
    expect(screen.getByRole('link', { name: 'Open original: Settings dialog' })).toHaveAttribute('href', asset('image'));
    expect(screen.getByRole('link', { name: 'Open original: Checkout flow' })).toHaveAttribute('target', '_blank');
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', asset('video'));
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveClass('w-full');
    expect(screen.queryByText('Untrusted')).toBeNull();
    expect(container.querySelector('img[src="https://evil.test/image.png"]')).toBeNull();
  });

  it('stacks every preview full width with bounded inline height', () => {
    const { container } = render(<TaskVisualPreviews previews={[
      { type: 'image', title: 'First', url: asset('first') },
      { type: 'image', title: 'Second', url: asset('second') },
    ]} />);
    const figures = container.querySelectorAll('figure');
    expect(figures).toHaveLength(2);
    figures.forEach(figure => expect(figure).toHaveClass('w-full'));
    expect(figures[0].parentElement).toHaveClass('flex-col');
    expect(figures[0].parentElement?.className).not.toMatch(/grid-cols|260px/);
    expect(screen.getByAltText('First')).toHaveClass('max-h-[65vh]', 'w-full', 'object-contain');
  });

  it('opens images in an in-app lightbox, skips videos, and restores focus on close', () => {
    render(<TaskVisualPreviews previews={[
      { type: 'image', title: 'First', url: asset('first') },
      { type: 'video', title: 'Walkthrough', url: asset('video') },
      { type: 'image', title: 'Second', url: asset('second') },
    ]} />);
    const trigger = screen.getByRole('button', { name: 'Open full-size preview: Second' });
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
  });

  it('renders nothing for runs without published previews', () => {
    expect(render(<TaskVisualPreviews />).container).toBeEmptyDOMElement();
    expect(render(<TaskVisualPreviews previews={[]} />).container).toBeEmptyDOMElement();
  });
});
