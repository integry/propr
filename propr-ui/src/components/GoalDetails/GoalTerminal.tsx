import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, Search } from 'lucide-react';
import type { GoalEvent, GoalEventType } from '../../api/goalsApi';
import { eventSearchText, sanitizeTerminalText } from './goalDetailUtils';

const EVENT_TYPES: GoalEventType[] = ['stdout', 'stderr', 'assistant', 'tool', 'checkpoint', 'usage', 'message', 'lifecycle'];
const MOUNT_LIMIT = 250;

const eventLabel = (event: GoalEvent): string => {
  const time = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${time} · ${event.source}${event.turnId ? ` · turn ${event.turnId}` : ''}`;
};

interface GoalTerminalProps {
  events: GoalEvent[];
  connectionState: 'connected' | 'recovering' | 'offline';
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => Promise<void>;
}

interface PendingScrollAnchor {
  sequence: number | null;
  viewportOffset: number;
  earliestSequence: number;
  navigationRevision: number;
  loadComplete: boolean;
  anchorRestored: boolean;
  previousFollowTail: boolean;
  previousWindowAnchor: number | null;
}

export default function GoalTerminal({ events, connectionState, hasMoreBefore, loadingOlder, onLoadOlder }: GoalTerminalProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pendingScrollAnchorRef = useRef<PendingScrollAnchor | null>(null);
  const navigationRevisionRef = useRef(0);
  const [query, setQuery] = useState('');
  const [enabledTypes, setEnabledTypes] = useState<Set<GoalEventType>>(new Set(EVENT_TYPES));
  const [followTail, setFollowTail] = useState(true);
  const [windowAnchor, setWindowAnchor] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [completedOlderLoads, setCompletedOlderLoads] = useState(0);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return events.filter(event => enabledTypes.has(event.type)
      && (!normalizedQuery || eventSearchText(event).includes(normalizedQuery)));
  }, [enabledTypes, events, query]);
  const latestStart = Math.max(0, filtered.length - MOUNT_LIMIT);
  const anchorIndex = windowAnchor === null ? -1 : filtered.findIndex(event => event.sequence === windowAnchor);
  const windowStart = followTail ? latestStart : anchorIndex >= 0 ? Math.min(anchorIndex, latestStart) : latestStart;
  const mounted = filtered.slice(windowStart, windowStart + MOUNT_LIMIT);
  const hasEarlierWindow = windowStart > 0;
  const hasLaterWindow = windowStart + MOUNT_LIMIT < filtered.length;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followTail) viewport.scrollTop = viewport.scrollHeight;
  }, [events, filtered.length, followTail]);

  useLayoutEffect(() => {
    const pending = pendingScrollAnchorRef.current;
    if (!pending) return;
    if (pending.navigationRevision !== navigationRevisionRef.current) {
      pendingScrollAnchorRef.current = null;
      return;
    }
    const hasPrependedEvents = events.some(event => event.sequence < pending.earliestSequence);
    if (!hasPrependedEvents) {
      if (pending.loadComplete) {
        pendingScrollAnchorRef.current = null;
        setFollowTail(pending.previousFollowTail);
        setWindowAnchor(pending.previousWindowAnchor);
      }
      return;
    }
    if (pending.anchorRestored) {
      if (pending.loadComplete) pendingScrollAnchorRef.current = null;
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport || pending.sequence === null) {
      if (pending.loadComplete) pendingScrollAnchorRef.current = null;
      return;
    }
    const anchor = viewport.querySelector<HTMLElement>(`[data-event-sequence="${pending.sequence}"]`);
    if (!anchor) {
      if (pending.loadComplete) pendingScrollAnchorRef.current = null;
      return;
    }
    viewport.scrollTop = anchor.offsetTop - pending.viewportOffset;
    pending.anchorRestored = true;
    if (pending.loadComplete) pendingScrollAnchorRef.current = null;
  }, [completedOlderLoads, events]);

  const recordNavigationIntent = () => {
    navigationRevisionRef.current += 1;
    const pending = pendingScrollAnchorRef.current;
    if (pending && pending.navigationRevision !== navigationRevisionRef.current) {
      pendingScrollAnchorRef.current = null;
    }
  };

  const resetFilteredWindow = () => {
    recordNavigationIntent();
    setWindowAnchor(null);
    setFollowTail(true);
  };

  const toggleType = (type: GoalEventType) => {
    setEnabledTypes(current => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
    resetFilteredWindow();
  };

  const moveWindow = (direction: -1 | 1) => {
    recordNavigationIntent();
    const nextStart = direction < 0
      ? Math.max(0, windowStart - MOUNT_LIMIT)
      : Math.min(latestStart, windowStart + MOUNT_LIMIT);
    setFollowTail(false);
    setWindowAnchor(filtered[nextStart]?.sequence ?? null);
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = 0;
  };

  const loadOlder = async () => {
    if (pendingScrollAnchorRef.current) return;
    const viewport = viewportRef.current;
    const rows = viewport ? [...viewport.querySelectorAll<HTMLElement>('[data-event-sequence]')] : [];
    const visible = rows.find(row => row.offsetTop + row.offsetHeight >= (viewport?.scrollTop ?? 0)) ?? rows[0];
    const pending: PendingScrollAnchor = {
      sequence: visible ? Number(visible.dataset.eventSequence) : null,
      viewportOffset: visible && viewport ? visible.offsetTop - viewport.scrollTop : 0,
      earliestSequence: events[0]?.sequence ?? Number.POSITIVE_INFINITY,
      navigationRevision: navigationRevisionRef.current,
      loadComplete: false,
      anchorRestored: false,
      previousFollowTail: followTail,
      previousWindowAnchor: windowAnchor,
    };
    pendingScrollAnchorRef.current = pending;
    setFollowTail(false);
    setWindowAnchor(mounted[0]?.sequence ?? null);
    try {
      await onLoadOlder();
    } finally {
      if (pendingScrollAnchorRef.current === pending) {
        if (pending.navigationRevision === navigationRevisionRef.current) {
          pending.loadComplete = true;
          setCompletedOlderLoads(count => count + 1);
        } else {
          pendingScrollAnchorRef.current = null;
        }
      }
    }
  };

  const copyVisible = async () => {
    const text = mounted.map(event => `[${eventLabel(event)}] ${event.type}: ${sanitizeTerminalText(event.content)}`).join('\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section aria-labelledby="goal-terminal-title" className="relative flex min-h-[28rem] flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950 text-zinc-200">
      <header className="border-b border-zinc-700 bg-zinc-900 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="goal-terminal-title" className="mr-auto font-mono text-sm font-semibold">Replayable terminal</h2>
          <span role="status" aria-live="polite" className={`text-xs ${connectionState === 'connected' ? 'text-emerald-400' : connectionState === 'recovering' ? 'text-amber-400' : 'text-red-400'}`}>
            {connectionState === 'connected' ? 'Live' : connectionState === 'recovering' ? 'Recovering · REST fallback active' : 'Offline · retrying'}
          </span>
          <button type="button" onClick={() => void copyVisible()} disabled={mounted.length === 0} aria-label="Copy visible terminal output" className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-40">
            {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Filter terminal event types">
          {EVENT_TYPES.map(type => (
            <button key={type} type="button" aria-pressed={enabledTypes.has(type)} onClick={() => toggleType(type)} className={`rounded px-2 py-1 font-mono text-[10px] uppercase ${enabledTypes.has(type) ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-500 ring-1 ring-zinc-700'}`}>
              {type}
            </button>
          ))}
        </div>
        <label className="relative mt-2 block">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
          <span className="sr-only">Search terminal output</span>
          <input type="search" value={query} onChange={event => { setQuery(event.target.value); resetFilteredWindow(); }} placeholder="Search output, source, or turn…" className="w-full rounded border border-zinc-700 bg-zinc-950 py-1.5 pl-8 pr-3 font-mono text-xs text-white placeholder:text-zinc-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500" />
        </label>
      </header>
      <div
        ref={viewportRef}
        onScroll={event => {
          recordNavigationIntent();
          const target = event.currentTarget;
          const atTail = target.scrollHeight - target.scrollTop - target.clientHeight < 48;
          if (!atTail && followTail) setWindowAnchor(mounted[0]?.sequence ?? null);
          setFollowTail(atTail && !hasLaterWindow);
        }}
        tabIndex={0}
        aria-label="Goal terminal transcript"
        className="scrollbar-stealth-dark min-h-0 flex-1 overflow-auto overscroll-contain font-mono text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 motion-reduce:scroll-auto"
      >
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-center gap-2 bg-zinc-950/95 p-2">
          {hasMoreBefore && <button type="button" onClick={() => void loadOlder().catch(() => undefined)} disabled={loadingOlder} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">{loadingOlder ? 'Loading older output…' : 'Load older output'}</button>}
          {filtered.length > MOUNT_LIMIT && (
            <nav aria-label="Terminal event windows" className="flex items-center gap-2">
              <button type="button" onClick={() => moveWindow(-1)} disabled={!hasEarlierWindow} aria-label="Earlier event window" className="rounded border border-zinc-700 p-1 disabled:opacity-40"><ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /></button>
              <span className="text-[10px] text-zinc-500">Events {windowStart + 1}–{windowStart + mounted.length} of {filtered.length}</span>
              <button type="button" onClick={() => moveWindow(1)} disabled={!hasLaterWindow} aria-label="Later event window" className="rounded border border-zinc-700 p-1 disabled:opacity-40"><ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></button>
            </nav>
          )}
        </div>
        {mounted.length === 0 && <p className="p-6 text-center text-zinc-500">No terminal events match these filters.</p>}
        <ol className="divide-y divide-zinc-900">
          {mounted.map((event, index) => {
            const previous = mounted[index - 1];
            const newTurn = index > 0 && previous.turnId !== event.turnId;
            return (
              <li key={event.sequence} data-event-sequence={event.sequence} className={`${newTurn ? 'border-t border-zinc-700' : ''} px-3 py-2`}>
                <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[10px] text-zinc-500">
                  <span className={`uppercase ${event.type === 'stderr' ? 'text-red-400' : event.type === 'assistant' ? 'text-cyan-400' : 'text-zinc-400'}`}>{event.type}</span>
                  <span>#{event.sequence}</span><span>{eventLabel(event)}</span>
                </div>
                <pre className="m-0 max-w-full whitespace-pre-wrap break-words font-mono leading-5 text-zinc-200">{sanitizeTerminalText(event.content)}</pre>
              </li>
            );
          })}
        </ol>
      </div>
      {!followTail && (
        <button type="button" onClick={() => { recordNavigationIntent(); setWindowAnchor(null); setFollowTail(true); const viewport = viewportRef.current; if (viewport) viewport.scrollTop = viewport.scrollHeight; requestAnimationFrame(() => { if (viewport) viewport.scrollTop = viewport.scrollHeight; }); }} className="absolute bottom-4 right-4 rounded-full bg-teal-600 px-3 py-1.5 text-xs font-medium text-white shadow motion-reduce:transition-none">
          Follow latest
        </button>
      )}
      <span className="sr-only" aria-live="polite">{copied ? 'Visible terminal output copied' : ''}</span>
    </section>
  );
}
