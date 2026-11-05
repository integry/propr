import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentUiPathname, replaceUiPathInPlace } from './runtimeMode';
import { isTrustedRendererUrl } from '../../../apps/desktop/src/security';

const reconfigureUrl = (url: string) => {
  (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom.reconfigure({ url });
};

afterEach(() => {
  reconfigureUrl('http://localhost:3000/');
  vi.unstubAllGlobals();
});

describe('replaceUiPathInPlace', () => {
  it('keeps the packaged renderer document trusted and preserves router state', () => {
    vi.stubGlobal('__PROPR_DESKTOP__', true);
    const renderer = 'propr-app://renderer/renderer.html';
    reconfigureUrl(`${renderer}#/studio/new`);
    const state = { idx: 2, key: 'new-plan', usr: { from: 'plans' } };
    window.history.replaceState(state, '');
    const length = window.history.length;
    replaceUiPathInPlace('/studio/draft-1?mode=task#details');
    expect(window.location.href).toBe(`${renderer}#/studio/draft-1?mode=task#details`);
    expect(currentUiPathname()).toBe('/studio/draft-1');
    expect(isTrustedRendererUrl(window.location.href, undefined, renderer)).toBe(true);
    expect(isTrustedRendererUrl('propr-app://renderer/studio/draft-1#/studio/new', undefined, renderer)).toBe(false);
    expect(window.history.state).toEqual(state);
    expect(window.history.length).toBe(length);
  });

  it('replaces the browser pathname without adding a history entry', () => {
    vi.stubGlobal('__PROPR_DESKTOP__', false);
    reconfigureUrl('https://app.example/studio/new');
    window.history.replaceState({ idx: 1, key: 'new-plan' }, '');
    const length = window.history.length;
    replaceUiPathInPlace('/studio/draft-1');
    expect(window.location.href).toBe('https://app.example/studio/draft-1');
    expect(window.history.state).toEqual({ idx: 1, key: 'new-plan' });
    expect(window.history.length).toBe(length);
  });

  it.each(['https://other.example/', '//other.example/', '/\\other.example/', '/bad\npath'])('ignores unsafe UI paths: %s', path => {
    vi.stubGlobal('__PROPR_DESKTOP__', true);
    reconfigureUrl('propr-app://renderer/renderer.html#/studio/new');
    replaceUiPathInPlace(path);
    expect(window.location.href).toBe('propr-app://renderer/renderer.html#/studio/new');
  });
});
