import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import DiffViewer from './DiffViewer';

const file = { path: 'src/example.ts', linesAdded: 1, linesRemoved: 0, status: 'added' as const, diff: '+export {};' };
const root = document.documentElement;

afterEach(() => { root.style.overscrollBehavior = ''; });

describe('DiffViewer root overscroll', () => {
  // Open, the popup stops a swipe past the diff's edge reaching the root (a history swipe or pull to refresh in touch
  // Chromium); closed or unmounted, the page gets back whatever overscroll it had, its own value included.
  it.each(['', 'contain', 'auto contain'])('holds the root at none while open and restores %j on unmount', previous => {
    root.style.overscrollBehavior = previous;
    const { unmount } = render(<DiffViewer file={file} onClose={() => {}} />);
    expect(root.style.overscrollBehavior).toBe('none');
    unmount();
    expect(root.style.overscrollBehavior).toBe(previous);
    expect(root.getAttribute('style') ?? '').toBe(previous ? `overscroll-behavior: ${previous};` : '');
  });
});
