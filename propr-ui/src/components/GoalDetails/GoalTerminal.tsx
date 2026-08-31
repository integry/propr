import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Search } from 'lucide-react';
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

export default function GoalTerminal({ events, connectionState, hasMoreBefore, loadingOlder, onLoadOlder }: GoalTerminalProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [enabledTypes, setEnabledTypes] = useState<Set<GoalEventType>>(new Set(EVENT_TYPES));
  const [followTail, setFollowTail] = useState(true);
  const [viewOldest, setViewOldest] = useState(false);
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return events.filter(event => enabledTypes.has(event.type)
      && (!normalizedQuery || eventSearchText(event).includes(normalizedQuery)));
  }, [enabledTypes, events, query]);
  const mounted = filtered.length > MOUNT_LIMIT
    ? viewOldest ? filtered.slice(0, MOUNT_LIMIT) : filtered.slice(-MOUNT_LIMIT)
    : filtered;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followTail) viewport.scrollTop = viewport.scrollHeight;
  }, [events, followTail]);

  const toggleType = (type: GoalEventType) => {
    setEnabledTypes(current => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  };

  const loadOlder = async () => {
    const viewport = viewportRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    setFollowTail(false);
    setViewOldest(true);
    await onLoadOlder();
    requestAnimationFrame(() => {
      if (viewport) viewport.scrollTop += viewport.scrollHeight - previousHeight;
    });
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
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search output, source, or turn…" className="w-full rounded border border-zinc-700 bg-zinc-950 py-1.5 pl-8 pr-3 font-mono text-xs text-white placeholder:text-zinc-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500" />
        </label>
      </header>
      <div
        ref={viewportRef}
        onScroll={event => {
          const target = event.currentTarget;
          setFollowTail(target.scrollHeight - target.scrollTop - target.clientHeight < 48);
        }}
        tabIndex={0}
        aria-label="Goal terminal transcript"
        className="scrollbar-stealth-dark min-h-0 flex-1 overflow-auto overscroll-contain font-mono text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 motion-reduce:scroll-auto"
      >
        {hasMoreBefore && (
          <div className="sticky top-0 z-10 flex justify-center bg-zinc-950/95 p-2">
            <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
              {loadingOlder ? 'Loading older output…' : 'Load older output'}
            </button>
          </div>
        )}
        {filtered.length > MOUNT_LIMIT && <p className="px-3 py-2 text-center text-[10px] text-zinc-500">Showing the {viewOldest ? 'oldest' : 'newest'} {MOUNT_LIMIT} matching events to keep this transcript responsive.</p>}
        {mounted.length === 0 && <p className="p-6 text-center text-zinc-500">No terminal events match these filters.</p>}
        <ol className="divide-y divide-zinc-900">
          {mounted.map((event, index) => {
            const previous = mounted[index - 1];
            const newTurn = index > 0 && previous.turnId !== event.turnId;
            return (
              <li key={event.sequence} className={`${newTurn ? 'border-t border-zinc-700' : ''} px-3 py-2`}>
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
        <button type="button" onClick={() => { setViewOldest(false); setFollowTail(true); const viewport = viewportRef.current; if (viewport) viewport.scrollTop = viewport.scrollHeight; requestAnimationFrame(() => { if (viewport) viewport.scrollTop = viewport.scrollHeight; }); }} className="absolute bottom-4 right-4 rounded-full bg-teal-600 px-3 py-1.5 text-xs font-medium text-white shadow motion-reduce:transition-none">
          Follow latest
        </button>
      )}
      <span className="sr-only" aria-live="polite">{copied ? 'Visible terminal output copied' : ''}</span>
    </section>
  );
}
