import { render, screen } from '@testing-library/react';
import { Zap } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreationDialog } from '../components/CreationDialog';
import FollowupModal from '../components/TaskDetails/FollowupModal';

/** A visual viewport the test can shrink and pan like an on-screen keyboard does. */
class FakeVisualViewport extends EventTarget {
  width = 384; height = 692; offsetTop = 0; offsetLeft = 0; scale = 1;
  listeners = 0;
  addEventListener(...args: Parameters<EventTarget['addEventListener']>) { this.listeners++; super.addEventListener(...args); }
  removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) { this.listeners--; super.removeEventListener(...args); }
  /** A pan following the caret only scrolls; the keyboard opening or closing also resizes. */
  set(next: Partial<Pick<FakeVisualViewport, 'height' | 'offsetTop' | 'scale'>>, events: Array<'resize' | 'scroll'> = ['resize', 'scroll']) {
    Object.assign(this, next);
    for (const type of events) this.dispatchEvent(new Event(type));
  }
}

let viewport: FakeVisualViewport;
const original = Object.getOwnPropertyDescriptor(window, 'visualViewport');

beforeEach(() => {
  viewport = new FakeVisualViewport();
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  // jsdom has no layout: the layer reports its stylesheet geometry (`inset-0`) unless clipped inline.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.style.top ? parseFloat(this.style.top) : 0;
    const height = this.style.height ? parseFloat(this.style.height) : 692 - top;
    return DOMRect.fromRect({ x: 0, y: top, width: 384, height });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (original) Object.defineProperty(window, 'visualViewport', original);
  else delete (window as { visualViewport?: VisualViewport }).visualViewport;
});

const dialog = (onClose = vi.fn()) => <CreationDialog title="New task" icon={Zap} description="Describe your task" closeLabel="Close task creation" onClose={onClose}>
  <textarea aria-label="Prompt" defaultValue="" />
</CreationDialog>;
const layer = () => screen.getByRole('dialog').closest<HTMLElement>('.app-modal-layer')!;

describe('creation dialog on a keyboard-sized visual viewport', () => {
  it('follows a shrunk, panned visual viewport and restores its stylesheet geometry', () => {
    render(dialog());
    expect(layer().style.top).toBe('');
    viewport.set({ height: 382.133, offsetTop: 186.133 });
    expect(layer().style.top).toBe('186.133px');
    expect(parseFloat(layer().style.height)).toBeCloseTo(382.133, 3);
    expect(layer().style.bottom).toBe('auto');
    viewport.set({ offsetTop: 40 }, ['scroll']);
    expect(layer().style.top).toBe('40px');
    viewport.set({ height: 300 }, ['resize']);
    expect(layer().style.height).toBe('300px');
    viewport.set({ height: 692, offsetTop: 0 });
    expect(layer().style.cssText).not.toMatch(/top|height|bottom/);
  });

  it('measures without unframing the live layer, so an unchanged frame leaves it untouched', () => {
    render(dialog());
    viewport.set({ height: 382.133, offsetTop: 186.133 });
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(layer(), { attributes: true });
    viewport.set({}, ['scroll']);
    viewport.set({}, ['resize']);
    window.dispatchEvent(new Event('resize'));
    mutations.push(...observer.takeRecords());
    observer.disconnect();
    expect(mutations).toEqual([]);
    expect(layer().style.top).toBe('186.133px');
    expect(document.querySelectorAll('.app-modal-layer')).toHaveLength(1);
  });

  it('positions from the current viewport when opened with the keyboard already up', () => {
    viewport.set({ height: 382, offsetTop: 300 });
    render(dialog());
    expect(layer().style.top).toBe('300px');
    expect(layer().style.height).toBe('382px');
  });

  it('leaves pinch zoom alone', () => {
    render(dialog());
    viewport.set({ height: 346, offsetTop: 120, scale: 2 });
    expect(layer().style.top).toBe('');
  });

  it('follows orientation changes and removes every listener on close', () => {
    const { unmount } = render(dialog());
    const listeners = viewport.listeners;
    expect(listeners).toBe(2);
    viewport.height = 200; viewport.offsetTop = 60;
    window.dispatchEvent(new Event('resize'));
    expect(layer().style.top).toBe('60px');
    unmount();
    expect(viewport.listeners).toBe(0);
    viewport.set({ height: 100, offsetTop: 10 });
    expect(document.querySelector('.app-modal-layer')).toBeNull();
  });

  it('frames a dialog that stays mounted while closed each time it opens, and releases it on close', () => {
    const followup = (isOpen: boolean) => <FollowupModal isOpen={isOpen} onClose={vi.fn()} onSubmit={vi.fn()} initialContent=""
      target={{ taskId: 'task-1', repository: 'integry/propr', kind: 'issue', number: 3243 }} />;
    const { rerender } = render(followup(false));
    expect(viewport.listeners).toBe(0);
    viewport.set({ height: 382.133, offsetTop: 146.4 });
    rerender(followup(true));
    expect(layer().style.top).toBe('146.4px');
    expect(viewport.listeners).toBe(2);
    rerender(followup(false));
    expect(viewport.listeners).toBe(0);
  });
});
