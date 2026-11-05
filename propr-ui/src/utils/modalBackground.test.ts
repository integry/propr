import { afterEach, describe, expect, it } from 'vitest';
import { inertOutside } from './modalBackground';

const isInert = (element: Element | null) => Boolean((element as HTMLElement | null)?.inert);

afterEach(() => { document.body.innerHTML = ''; });

describe('inertOutside', () => {
  it('makes the workspace around an inline dialog inert but leaves window chrome and the dialog live', () => {
    document.body.innerHTML = `
      <div id="root">
        <div class="desktop-app">
          <nav id="nav"></nav>
          <main id="main"><section id="task"></section><div id="backdrop"><div id="dialog"></div></div></main>
        </div>
        <div id="controls" data-window-chrome><button id="close-window"></button></div>
      </div>
      <div id="toast"></div>`;
    const restore = inertOutside(document.getElementById('dialog')!);
    for (const id of ['nav', 'task', 'toast']) expect(isInert(document.getElementById(id)), id).toBe(true);
    for (const id of ['root', 'main', 'backdrop', 'dialog', 'controls', 'close-window']) expect(isInert(document.getElementById(id)), id).toBe(false);
    restore();
    for (const element of Array.from(document.querySelectorAll('*'))) expect(isInert(element), element.id).toBe(false);
  });

  it('keeps chrome inside the root live when the dialog is portaled to body, and leaves already-inert regions alone', () => {
    document.body.innerHTML = `
      <div id="root"><div id="app"><div id="hidden-pane"></div></div><div id="controls" data-window-chrome></div></div>
      <div id="portal"><div id="dialog"></div></div>`;
    const hiddenPane = document.getElementById('hidden-pane')!;
    hiddenPane.inert = true;
    const restore = inertOutside(document.getElementById('dialog')!);
    expect(isInert(document.getElementById('app'))).toBe(true);
    expect(isInert(document.getElementById('root'))).toBe(false);
    expect(isInert(document.getElementById('controls'))).toBe(false);
    restore();
    expect(isInert(document.getElementById('app'))).toBe(false);
    expect(hiddenPane.inert).toBe(true);
  });
});
