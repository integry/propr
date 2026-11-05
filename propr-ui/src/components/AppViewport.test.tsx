import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppViewport } from './AppViewport';

describe('AppViewport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fills the browser viewport on the web', () => {
    const { container } = render(<AppViewport>content</AppViewport>);
    expect(container.firstElementChild).toHaveClass('h-screen');
  });

  it('fills its desktop container instead of the viewport, which excludes the Linux frame allowance', () => {
    vi.stubGlobal('__PROPR_DESKTOP__', true);
    const { container } = render(<AppViewport banner={<div>banner</div>} offset>content</AppViewport>);
    expect(container.firstElementChild).toHaveClass('h-full', 'pt-9');
    expect(container.firstElementChild).not.toHaveClass('h-screen');
  });
});
