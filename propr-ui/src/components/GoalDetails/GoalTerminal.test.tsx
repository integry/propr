import { useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GoalTerminal from './GoalTerminal';
import { GOAL_EVENT_RETENTION_LIMIT, mergeGoalEvents, sanitizeTerminalText, type GoalViewportAnchor } from './goalDetailUtils';
import { deferred, goalEvent as event } from './goalDetailsTestFixtures';

describe('GoalTerminal', () => {
  it('renders ANSI and HTML as inert text, filters streams, and bounds large mounted histories', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const events = Array.from({ length: 300 }, (_, index) => event(index + 1));
    events[299] = event(300, 'stderr', '\u001b[31m<script>alert(1)</script>\u001b[0m');
    render(<GoalTerminal events={events} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={vi.fn()} />);
    expect(screen.getByText('Events 51–300 of 300')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(sanitizeTerminalText('\u001b[31mred\u001b[0m')).toBe('red');
    fireEvent.click(screen.getByRole('button', { name: 'stdout' }));
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible terminal output' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(expect.not.stringContaining('\u001b')));
    expect(screen.getByText('Visible terminal output copied')).toBeInTheDocument();
  });

  it('sanitizes malicious source and turn metadata into single-line inert clipboard labels', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const malicious = {
      ...event(1, 'stdout', '<img src=x onerror=alert(1)>'),
      source: '\u001b[31mcodex\n[forged source]\u0007',
      turnId: 'turn-1\r\n[forged turn]\u009B31m',
    };
    render(<GoalTerminal events={[malicious]} connectionState="connected" hasMoreBefore={false} loadingOlder={false} onLoadOlder={vi.fn()} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible terminal output' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledOnce());
    const copied = clipboard.writeText.mock.calls[0][0];
    expect(copied).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    expect(copied).not.toContain('\n[forged');
    expect(copied).toContain('codex [forged source]');
    expect(copied).toContain('turn turn-1 [forged turn]');
  });

  it('announces clipboard unavailability and rejection without leaking an unhandled promise', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const view = render(<GoalTerminal events={[event(1)]} connectionState="connected" hasMoreBefore={false} loadingOlder={false} onLoadOlder={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible terminal output' }));
    expect(await screen.findByText('Unable to copy visible terminal output')).toBeInTheDocument();

    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    view.rerender(<GoalTerminal events={[event(1)]} connectionState="connected" hasMoreBefore={false} loadingOlder={false} onLoadOlder={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible terminal output' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledOnce());
    expect(screen.getByText('Unable to copy visible terminal output')).toBeInTheDocument();
  });

  it('navigates through every loaded middle window and reapplies windowing after search', () => {
    const events = Array.from({ length: 800 }, (_, index) => event(index + 1));
    render(<GoalTerminal events={events} connectionState="connected" hasMoreBefore={false} loadingOlder={false} onLoadOlder={vi.fn()} />);
    expect(screen.getByText('Events 551–800 of 800')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier event window' }));
    expect(screen.getByText('Events 301–550 of 800')).toBeInTheDocument();
    expect(screen.getByText('line 420')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier event window' }));
    expect(screen.getByText('Events 51–300 of 800')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search terminal output' }), { target: { value: 'line 420' } });
    expect(screen.getByText('line 420')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Terminal event windows' })).not.toBeInTheDocument();
  });

  it('stops following when the operator scrolls away and exposes explicit follow-tail recovery', () => {
    const { rerender } = render(<GoalTerminal events={[event(1)]} connectionState="recovering" hasMoreBefore={false} loadingOlder={false} onLoadOlder={vi.fn()} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } });
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    rerender(<GoalTerminal events={[event(1), event(2)]} connectionState="recovering" hasMoreBefore={false} loadingOlder={false} onLoadOlder={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Follow latest' })).toBeInTheDocument();
    expect(viewport.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole('button', { name: 'Follow latest' }));
    expect(viewport.scrollTop).toBe(1000);
  });

  it('preserves the visible position when an older page is prepended', async () => {
    let height = 500;
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() {
      return (this as HTMLElement).dataset.eventSequence === '1' ? (height === 500 ? 100 : 300) : 0;
    } });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 20 });
    let view: ReturnType<typeof render>;
    const onLoadOlder = vi.fn(async () => {
      height = 700;
      view.rerender(<GoalTerminal events={[event(0), event(1), event(2)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    });
    view = render(<GoalTerminal events={[event(1)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => height });
    viewport.scrollTop = 30;
    fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
    await waitFor(() => expect(viewport.scrollTop).toBe(230));
    expect(screen.getByText('line 2')).toBeInTheDocument();
    delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  });

  it('keeps one historical row and pixel offset through repeated bounded trims and concurrent live arrivals', async () => {
    let layoutShift = 0;
    let liveSequence = 1_500;
    const olderStarts = [301, 101, -99];
    const loadCounts: number[] = [];
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() {
      return (this as HTMLElement).dataset.eventSequence === '1001' ? 100 + layoutShift : 2_000;
    } });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 20 });

    function RetentionHarness() {
      const anchorRef = useRef<GoalViewportAnchor | null>(null);
      const [events, setEvents] = useState(() => mergeGoalEvents(
        [], Array.from({ length: 1_500 }, (_, index) => event(index + 1)), 'goal-1'
      ));
      const loadOlder = async () => {
        const start = olderStarts[loadCounts.length];
        layoutShift += 200;
        liveSequence += 1;
        setEvents(current => {
          const retention = { viewportAnchorSequence: anchorRef.current?.sequence };
          const withOlder = mergeGoalEvents(
            current, Array.from({ length: 200 }, (_, index) => event(start + index)), 'goal-1',
            { ...retention, ingestion: 'older' }
          );
          return mergeGoalEvents(withOlder, [event(liveSequence)], 'goal-1', retention);
        });
        loadCounts.push(loadCounts.length + 1);
      };
      return <>
        <output data-testid="retained-tail">{events.length}:{events.at(-1)?.sequence}</output>
        <GoalTerminal
          events={events}
          connectionState="connected"
          hasMoreBefore
          loadingOlder={false}
          onLoadOlder={loadOlder}
          onViewportAnchorChange={anchor => { anchorRef.current = anchor; }}
        />
      </>;
    }

    render(<RetentionHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier event window' }));
    expect(screen.getByText('line 1001')).toBeInTheDocument();
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 3_000 },
      clientHeight: { configurable: true, value: 200 },
    });
    viewport.scrollTop = 30;
    fireEvent.scroll(viewport);
    const anchor = screen.getByText('line 1001').closest('[data-event-sequence]') as HTMLElement;
    expect(anchor.offsetTop - viewport.scrollTop).toBe(70);

    for (let load = 1; load <= olderStarts.length; load += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
      await waitFor(() => expect(loadCounts).toHaveLength(load));
      await waitFor(() => expect(anchor.offsetTop - viewport.scrollTop).toBe(70));
      expect(screen.getByText('line 1001')).toBeInTheDocument();
      expect(screen.getByText(new RegExp(`of ${GOAL_EVENT_RETENTION_LIMIT}$`))).toBeInTheDocument();
      expect(screen.getByTestId('retained-tail')).toHaveTextContent(`${GOAL_EVENT_RETENTION_LIMIT}:${liveSequence}`);
    }

    delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  });

  it('falls back deterministically to the live tail only when the retained row is genuinely unavailable', () => {
    const anchors: Array<GoalViewportAnchor | null> = [];
    const events = Array.from({ length: 800 }, (_, index) => event(index + 1));
    const view = render(<GoalTerminal events={events} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={vi.fn()} onViewportAnchorChange={anchor => anchors.push(anchor)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier event window' }));
    expect(screen.getByText('line 301')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Follow latest' })).toBeInTheDocument();

    view.rerender(<GoalTerminal events={events.slice(550)} connectionState="connected" hasMoreBefore={false} loadingOlder={false} onLoadOlder={vi.fn()} onViewportAnchorChange={anchor => anchors.push(anchor)} />);

    expect(screen.getByText('line 800')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument();
    expect(anchors.at(-1)).toBeNull();
  });

  it('restores tail-follow after repeated empty older loads and follows the next live event', async () => {
    let height = 500;
    const onLoadOlder = vi.fn().mockResolvedValue(undefined);
    const view = render(<GoalTerminal events={[event(1)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => height });
    viewport.scrollTop = height;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
      await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(attempt));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument());
    }

    height = 700;
    view.rerender(<GoalTerminal events={[event(1), event(2)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    await waitFor(() => expect(viewport.scrollTop).toBe(700));
    expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument();
  });

  it('preserves a pre-existing non-tail state after an empty older load', async () => {
    const onLoadOlder = vi.fn().mockResolvedValue(undefined);
    const view = render(<GoalTerminal events={[event(1), event(2)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);

    fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Follow latest' })).toBeInTheDocument());
    view.rerender(<GoalTerminal events={[event(1), event(2), event(3)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    expect(viewport.scrollTop).toBe(100);
  });

  it.each(['empty', 'rejected'] as const)('keeps a newer follow-latest intent after an %s older load and follows the next live event', async outcome => {
    const load = deferred<void>();
    let height = 500;
    const onLoadOlder = vi.fn(() => load.promise);
    const view = render(<GoalTerminal events={[event(1), event(2)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 200 },
    });
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);

    fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
    expect(onLoadOlder).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Follow latest' }));
    expect(viewport.scrollTop).toBe(500);
    view.rerender(<GoalTerminal events={[event(1), event(2)]} connectionState="recovering" hasMoreBefore loadingOlder onLoadOlder={onLoadOlder} />);

    await act(async () => {
      if (outcome === 'empty') load.resolve(); else load.reject(new Error('older history unavailable'));
      await load.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument();

    height = 700;
    view.rerender(<GoalTerminal events={[event(1), event(2), event(3)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    await waitFor(() => expect(viewport.scrollTop).toBe(700));
    expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument();
  });

  it('keeps a search reset made while an empty older load is pending', async () => {
    const load = deferred<void>();
    const events = Array.from({ length: 800 }, (_, index) => event(index + 1));
    const onLoadOlder = vi.fn(() => load.promise);
    const view = render(<GoalTerminal events={events} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier event window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search terminal output' }), { target: { value: 'line 420' } });
    expect(screen.getByText('line 420')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument();

    view.rerender(<GoalTerminal events={events} connectionState="recovering" hasMoreBefore loadingOlder onLoadOlder={onLoadOlder} />);
    await act(async () => { load.resolve(); await load.promise; });

    expect(screen.getByText('line 420')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument();
    view.rerender(<GoalTerminal events={events} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search terminal output' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(2));
  });

  it('does not restore a successful prepend anchor over newer manual scroll intent', async () => {
    const load = deferred<void>();
    let prepended = false;
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() {
      return (this as HTMLElement).dataset.eventSequence === '551' ? (prepended ? 300 : 100) : 0;
    } });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 20 });
    const events = Array.from({ length: 800 }, (_, index) => event(index + 1));
    const onLoadOlder = vi.fn(() => load.promise);
    const view = render(<GoalTerminal events={events} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    viewport.scrollTop = 30;
    fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
    viewport.scrollTop = 80;
    fireEvent.scroll(viewport);

    prepended = true;
    view.rerender(<GoalTerminal events={[event(0), ...events]} connectionState="connected" hasMoreBefore loadingOlder onLoadOlder={onLoadOlder} />);
    expect(viewport.scrollTop).toBe(80);
    await act(async () => { load.resolve(); await load.promise; });
    expect(viewport.scrollTop).toBe(80);

    delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  });

  it('restores tail-follow after a rejected older load across rerenders and follows the next live event', async () => {
    let rejectLoad: (reason: Error) => void = () => undefined;
    let height = 500;
    const onLoadOlder = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLoad = reject; }));
    const view = render(<GoalTerminal events={[event(1)]} connectionState="connected" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    const viewport = screen.getByLabelText('Goal terminal transcript');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => height });
    viewport.scrollTop = height;

    fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
    expect(screen.getByRole('button', { name: 'Follow latest' })).toBeInTheDocument();
    view.rerender(<GoalTerminal events={[event(1)]} connectionState="recovering" hasMoreBefore loadingOlder onLoadOlder={onLoadOlder} />);
    await act(async () => { rejectLoad(new Error('older history unavailable')); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument());

    height = 700;
    view.rerender(<GoalTerminal events={[event(1), event(2)]} connectionState="recovering" hasMoreBefore loadingOlder={false} onLoadOlder={onLoadOlder} />);
    await waitFor(() => expect(viewport.scrollTop).toBe(700));
    expect(screen.queryByRole('button', { name: 'Follow latest' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load older output' }));
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(2));
  });
});
