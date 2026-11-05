import { renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useLockTaskScroll } from './useLockTaskScroll';

it('locks explicit targets independently of test ids and restores styles and scroll after the last owner', () => {
  const pane = document.createElement('div');
  pane.setAttribute('data-scroll-lock-target', '');
  pane.style.overflow = 'auto';
  const unrelated = document.createElement('div');
  unrelated.dataset.testid = 'task-details';
  document.body.append(pane, unrelated);
  document.body.style.setProperty('position', 'relative', 'important');
  document.body.style.top = '2px';
  const original = document.body.style.cssText;
  vi.stubGlobal('scrollX', 12);
  vi.stubGlobal('scrollY', 140);
  const scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
  const first = renderHook(({ open }) => useLockTaskScroll(open), { initialProps: { open: false } });
  expect(pane.style.overflow).toBe('auto');
  first.rerender({ open: true });
  const second = renderHook(() => useLockTaskScroll(true));
  expect(getComputedStyle(pane).overflow).toBe('hidden');
  expect(unrelated.style.overflow).toBe('');
  expect(document.body.style.position).toBe('fixed');
  expect(document.body.style.top).toBe('-140px');
  expect(document.body.style.left).toBe('-12px');
  first.rerender({ open: false });
  expect(document.body.style.position).toBe('fixed');
  expect(scrollTo).not.toHaveBeenCalled();
  vi.stubGlobal('scrollY', 0);
  second.unmount();
  expect(document.body.style.cssText).toBe(original);
  expect(pane.style.overflow).toBe('auto');
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 12, top: 140, behavior: 'instant' });
  first.unmount();
  pane.remove();
  unrelated.remove();
  document.body.removeAttribute('style');
  vi.unstubAllGlobals();
});

it('releases locks when scrollTo is absent', () => {
  vi.stubGlobal('scrollTo', undefined);
  const { unmount } = renderHook(() => useLockTaskScroll(true));
  expect(() => unmount()).not.toThrow();
  expect(document.body.style.position).toBe('');
  vi.unstubAllGlobals();
});

it('locks remounted panes until the last owner releases without overwriting their styles', () => {
  const first = renderHook(() => useLockTaskScroll(true));
  const second = renderHook(() => useLockTaskScroll(true));
  const pane = document.createElement('main');
  pane.setAttribute('data-scroll-lock-target', '');
  document.body.append(pane);
  expect(getComputedStyle(pane).overflow).toBe('hidden');
  const replacement = pane.cloneNode() as HTMLElement;
  pane.replaceWith(replacement);
  first.unmount();
  expect(getComputedStyle(replacement).overflow).toBe('hidden');
  replacement.style.overflow = 'scroll';
  second.unmount();
  expect(getComputedStyle(replacement).overflow).toBe('scroll');
  replacement.remove();
});
