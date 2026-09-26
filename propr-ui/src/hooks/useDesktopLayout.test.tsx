import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useDesktopLayout } from './useDesktopLayout';

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');

describe('useDesktopLayout fallback', () => {
  afterEach(() => {
    if (originalMatchMedia) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    } else {
      Reflect.deleteProperty(window, 'matchMedia');
    }

    if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth);
  });

  it('treats 700px as mobile during initialization and resize without matchMedia', () => {
    Reflect.deleteProperty(window, 'matchMedia');
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 700,
    });

    const { result } = renderHook(() => useDesktopLayout());
    expect(result.current).toBe(false);

    act(() => {
      window.innerWidth = 800;
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe(true);

    act(() => {
      window.innerWidth = 700;
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe(false);
  });
});
