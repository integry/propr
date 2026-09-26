import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublishedVisualPreview } from '@propr/shared';
import PreviewLightbox from './PreviewLightbox';

const previews: PublishedVisualPreview[] = ['Dashboard', 'Settings', 'Billing'].map(title => ({
  type: 'image', title, url: `https://github.com/user-attachments/assets/${title.toLowerCase()}`,
}));

function Harness({ items = previews, onClose = () => {}, returnFocusTo }: { items?: PublishedVisualPreview[]; onClose?: () => void; returnFocusTo?: HTMLElement | null }) {
  const [index, setIndex] = useState(0);
  return <PreviewLightbox previews={items} index={index} onIndexChange={setIndex} onClose={onClose} returnFocusTo={returnFocusTo} />;
}

const stage = () => screen.getByTestId('preview-lightbox-stage');
const image = () => screen.getByRole('dialog').querySelector('img') as HTMLImageElement;
const scaleOf = () => Number(/scale\(([\d.]+)\)/.exec(image().style.transform)?.[1]);
const translateOf = () => (/translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(image().style.transform) ?? []).slice(1).map(Number);
const touch = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', pointerId: number, clientX: number, clientY: number, target: Element = stage()) =>
  fireEvent[type](target, { pointerId, pointerType: 'touch', clientX, clientY, isPrimary: pointerId === 1 });

afterEach(() => {
  document.body.style.overflow = '';
});

describe('PreviewLightbox', () => {
  it('renders a labelled modal dialog in a body portal, fitted to the screen, and locks background scroll', () => {
    const { unmount } = render(<div className="overflow-hidden"><Harness /></div>);
    const dialog = screen.getByRole('dialog', { name: 'Dashboard' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog).toHaveClass('fixed', 'inset-0', 'z-[70]');
    expect(image()).toHaveClass('max-h-full', 'max-w-full', 'object-contain');
    expect(scaleOf()).toBe(1);
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('button', { name: 'Close preview' })).toHaveFocus();
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('pinch-zooms with two fingers and pans with one finger once zoomed', () => {
    render(<Harness />);
    touch('pointerDown', 1, 100, 100);
    touch('pointerDown', 2, 200, 100);
    touch('pointerMove', 2, 300, 100);
    expect(scaleOf()).toBeGreaterThan(1);
    expect(scaleOf()).toBeCloseTo(2);
    touch('pointerUp', 2, 300, 100);
    touch('pointerUp', 1, 100, 100);
    const [x, y] = translateOf();
    touch('pointerDown', 1, 50, 50);
    touch('pointerMove', 1, 90, 20);
    expect(translateOf()).toEqual([x + 40, y - 30]);
    touch('pointerUp', 1, 90, 20);
    expect(scaleOf()).toBeCloseTo(2);
  });

  it('caps pinch zoom between 1x and 4x', () => {
    render(<Harness />);
    touch('pointerDown', 1, 0, 0);
    touch('pointerDown', 2, 10, 0);
    touch('pointerMove', 2, 500, 0);
    expect(scaleOf()).toBe(4);
    touch('pointerMove', 2, 1, 0);
    expect(scaleOf()).toBe(1);
  });

  it('does not pan at fit scale', () => {
    render(<Harness />);
    touch('pointerDown', 1, 50, 50);
    touch('pointerMove', 1, 150, 150);
    expect(translateOf()).toEqual([0, 0]);
  });

  it('double-tap toggles between fit and 2.5x anchored at the tap point', () => {
    render(<Harness />);
    touch('pointerDown', 1, 40, 20, image());
    touch('pointerUp', 1, 40, 20, image());
    touch('pointerDown', 1, 42, 21, image());
    touch('pointerUp', 1, 42, 21, image());
    expect(scaleOf()).toBe(2.5);
    // jsdom rects are zero-sized, so the anchor is (42, 21) from the stage centre.
    expect(translateOf()).toEqual([42 - 42 * 2.5, 21 - 21 * 2.5]);
    touch('pointerDown', 1, 42, 21, image());
    touch('pointerUp', 1, 42, 21, image());
    touch('pointerDown', 1, 42, 21, image());
    touch('pointerUp', 1, 42, 21, image());
    expect(scaleOf()).toBe(1);
  });

  it('double-click, zoom buttons, keyboard and Ctrl+wheel change the zoom level', () => {
    render(<Harness />);
    fireEvent.doubleClick(image());
    expect(scaleOf()).toBe(2.5);
    fireEvent.doubleClick(image());
    expect(scaleOf()).toBe(1);
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(scaleOf()).toBe(1.5);
    expect(screen.getByRole('button', { name: 'Reset zoom (currently 150%)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(scaleOf()).toBe(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: '+' });
    expect(scaleOf()).toBe(1.5);
    fireEvent.click(screen.getByRole('button', { name: /Reset zoom/ }));
    expect(scaleOf()).toBe(1);

    const wheel = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { image().dispatchEvent(wheel); });
    expect(wheel.defaultPrevented).toBe(true);
    expect(scaleOf()).toBeGreaterThan(1);
    const scroll = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    act(() => { stage().dispatchEvent(scroll); });
    expect(scroll.defaultPrevented).toBe(true);
  });

  it('closes on Escape and backdrop click but not on image clicks or after a pan', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(image());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.doubleClick(image());
    touch('pointerDown', 1, 10, 10);
    touch('pointerMove', 1, 80, 80);
    touch('pointerUp', 1, 80, 80);
    fireEvent.click(stage());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(stage());
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('navigates with arrow keys and buttons, updates the counter and resets zoom', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(scaleOf()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Next preview' }));
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'Dashboard' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous preview' }));
    expect(image()).toHaveAttribute('src', previews[2].url);
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
  });

  it('hides gallery controls for a single preview', () => {
    render(<Harness items={[previews[0]]} />);
    expect(screen.queryByRole('button', { name: 'Next preview' })).toBeNull();
    expect(screen.queryByText('1 / 1')).toBeNull();
  });

  it('traps focus inside the dialog and returns it to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    const { unmount } = render(<Harness returnFocusTo={opener} />);
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close preview' });
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const last = buttons[buttons.length - 1];
    expect(close).toHaveFocus();
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(buttons[0], { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
  it('keeps focus in the dialog when background content is focused by a document-level shortcut', () => {
    const search = document.createElement('input');
    document.body.appendChild(search);
    const focusSearch = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 'k') search.focus();
    };
    document.addEventListener('keydown', focusSearch);
    const { unmount } = render(<Harness />);
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    zoomIn.focus();
    fireEvent.keyDown(zoomIn, { key: 'k', ctrlKey: true });
    expect(search).not.toHaveFocus();
    expect(zoomIn).toHaveFocus();

    act(() => { search.focus(); });
    expect(zoomIn).toHaveFocus();
    // With nothing focused, the next Tab still lands inside the dialog.
    zoomIn.blur();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

    unmount();
    search.focus();
    expect(search).toHaveFocus();
    document.removeEventListener('keydown', focusSearch);
    search.remove();
  });
});
