import React, { useId, useMemo, useState } from 'react';
import { LiveEvent, TodoItem } from './types';
import { renderMarkdown } from './renderMarkdown';
import { Lightbulb, Wrench, Search, CheckCircle2, MessageSquare, ChevronRight } from 'lucide-react';
import { formatReviewPromptOverview } from './reviewPromptOverview';
import { HISTORY_TRUNCATED_NOTICE } from './liveDetailsMerge';
import { readableThoughts } from './thoughtContent';
import { formatRelativeTime } from './utils';
import {
  CheckpointLogEntry,
} from './CheckpointLogEntry';
import {
  prepareCheckpointEvents,
  type CheckpointOutcome,
  type PreparedThinkingLogEvent,
} from './checkpointLog';

// Simple thought type detection based on content. A summary is never guessed from wording: mid-run
// notes such as "Worker side is done" read like one, so only a finished run's closing message is a summary.
const detectThoughtType = (content: string): 'analysis' | 'action' | 'search' => {
  const lower = content.toLowerCase();
  if (lower.includes('search') || lower.includes('find') || lower.includes('look for')) return 'search';
  if (lower.includes('create') || lower.includes('update') || lower.includes('modify') || lower.includes('implement')) return 'action';
  return 'analysis';
};

/** A log step, marked when it is the closing message of a run that has finished. */
type LogEvent = PreparedThinkingLogEvent & { final?: boolean };

const isAgentStep = (event: PreparedThinkingLogEvent): boolean => event.type !== 'user_input' && !event.checkpoint;

/** Marks the last agent step as the run's summary once the run has stopped streaming. */
const markFinalStep = (events: PreparedThinkingLogEvent[], streaming: boolean): LogEvent[] => {
  if (streaming) return events;
  let finalIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (isAgentStep(events[index])) {
      finalIndex = index;
      break;
    }
  }
  if (finalIndex < 0) return events;
  return events.map((event, index) => (index === finalIndex ? { ...event, final: true } : event));
};

interface ThinkingLogEvent extends LiveEvent {
  relativeTime?: string | null;
}

// The entry's first line on the right is 14px text on `leading-relaxed`, i.e. a 1.4219rem line box.
// The gutter's label row claims exactly that box and centres in it, so `ACTION` and the first line of
// the entry start on the same horizontal line instead of the label floating a couple of pixels above.
const gutterLabelRow = 'flex min-h-[1.4219rem] items-center gap-1.5';

interface ThinkingLogProps {
  events: ThinkingLogEvent[];
  todos?: TodoItem[];
  highlightedTodoId?: string | null;
  /** The run is still producing output: its newest reasoning stays open while it streams. */
  streaming?: boolean;
  /** Earlier output was discarded by the server, so the oldest messages may be missing. */
  historyTruncated?: boolean;
  /** Durable worker state for the newest agent checkpoint declaration, when the payload matches. */
  checkpointOutcome?: CheckpointOutcome | null;
  /** Shown when the run recorded no steps; without it, an empty log renders nothing. */
  emptyMessage?: string;
}

// Get category display info for gutter-style output
// Icons use low-saturation colors (60% opacity), labels use accessible slate metadata tones.
const getCategoryInfo = (type: 'analysis' | 'action' | 'summary' | 'search') => {
  switch (type) {
    case 'summary':
      return {
        label: 'SUMMARY',
        iconColor: 'text-amber-500/60',
        Icon: CheckCircle2
      };
    case 'action':
      return {
        label: 'ACTION',
        iconColor: 'text-emerald-500/60',
        Icon: Wrench
      };
    case 'search':
      return {
        label: 'SEARCH',
        iconColor: 'text-purple-500/60',
        Icon: Search
      };
    case 'analysis':
    default:
      return {
        label: 'ANALYSIS',
        iconColor: 'text-blue-500/60',
        Icon: Lightbulb
      };
  }
};

// Operator steering message. Only the goal timeline merges these in; task detail
// streams never contain a `user_input` event, so this branch stays unreachable there.
const UserMessageEntry: React.FC<{ event: ThinkingLogEvent }> = ({ event }) => (
  <div data-testid="goal-user-message" className="py-3 border-b border-slate-50 last:border-b-0">
    <div className="flex items-start gap-3">
      {/* Left Gutter - distinct YOU label and icon */}
      <div className="flex-shrink-0 w-[100px] flex flex-col items-start">
        <div className="flex items-center gap-1.5">
          <MessageSquare className="h-3 w-3 text-amber-500" />
          <span className="text-[11px] font-mono font-bold uppercase tracking-tighter text-amber-600">
            YOU
          </span>
        </div>
        {event.relativeTime && (
          <span className="font-mono text-[10px] text-slate-500 mt-0.5 ml-[18px]">
            {event.relativeTime}
          </span>
        )}
      </div>

      {/* Right Pane - the message exactly as it was sent */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="border-l-2 border-amber-400 bg-amber-50/60 px-3 py-2">
          <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">
            {event.content}
          </p>
          {(event.inputState === 'pending' || event.inputState === 'undeliverable' || !!event.attachmentCount) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {event.inputState === 'pending' && (
                <span className="rounded border border-amber-300 bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700">
                  Queued
                </span>
              )}
              {event.inputState === 'undeliverable' && (
                <span className="rounded border border-red-200 bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-600">
                  Not delivered
                </span>
              )}
              {!!event.attachmentCount && (
                <span className="text-[10px] text-slate-500">
                  {event.attachmentCount} attachment{event.attachmentCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  </div>
);

interface TerminalLogEntryProps {
  event: LogEvent;
  todoContext?: string;
  isHighlighted?: boolean;
}

const TerminalLogEntry: React.FC<TerminalLogEntryProps> = ({ event, todoContext, isHighlighted }) => {
  if (event.type === 'user_input') {
    return <UserMessageEntry event={event} />;
  }

  const checkpoint = event.checkpoint;
  if (checkpoint) {
    return <CheckpointLogEntry event={event} checkpoint={checkpoint} />;
  }

  const displayContent = formatReviewPromptOverview(event.content) ?? event.content;
  const thoughtType = event.final ? 'summary' : detectThoughtType(displayContent || '');
  const categoryInfo = getCategoryInfo(thoughtType);
  const { Icon } = categoryInfo;

  return (
    <div
      className={`py-3 transition-all duration-200 border-b border-slate-50 last:border-b-0 ${
        isHighlighted ? 'bg-blue-50/50' : ''
      }`}
    >
      {/* Gutter Layout: Two-Column Row */}
      <div className="flex items-start gap-3">
        {/* Left Gutter (100px) - Icon, Category Label, Timestamp */}
        <div className="flex-shrink-0 w-[100px] flex flex-col items-start">
          {/* Icon + Category Label Row, on the same line box as the entry's first line of text */}
          <div className={gutterLabelRow}>
            <Icon className={`h-3 w-3 ${categoryInfo.iconColor}`} />
            <span className="text-[11px] font-mono font-bold uppercase tracking-tighter text-slate-500">
              {categoryInfo.label}
            </span>
          </div>
          {/* Timestamp below category label */}
          {event.relativeTime && (
            <span className="font-mono text-[10px] text-slate-500 mt-0.5 ml-[18px]">
              {event.relativeTime}
            </span>
          )}
          {/* Todo context if available */}
          {todoContext && (
            <span className="text-[9px] text-slate-500 truncate mt-0.5 ml-[18px]">
              → {todoContext}
            </span>
          )}
        </div>

        {/* Right Pane - Content */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {displayContent && (
            <div className="text-sm text-slate-700 leading-relaxed break-words overflow-hidden">
              {renderMarkdown(displayContent)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/** Reasoning entries; actions, findings, checkpoints and operator messages stay in the main flow. */
const isAnalysisEntry = (event: LogEvent): boolean => {
  if (!isAgentStep(event) || event.final) return false;
  const displayContent = formatReviewPromptOverview(event.content) ?? event.content;
  return detectThoughtType(displayContent || '') === 'analysis';
};

type LogSegment =
  | { kind: 'entry'; start: number; event: LogEvent }
  | { kind: 'thoughts'; start: number; events: LogEvent[]; durationMs: number | null };

const timeOf = (event?: PreparedThinkingLogEvent): number | null => {
  const time = event?.timestamp ? Date.parse(event.timestamp) : NaN;
  return Number.isFinite(time) ? time : null;
};

/** Folds each run of consecutive reasoning entries into one segment, timed until the step that followed it. */
const segmentEvents = (events: LogEvent[]): LogSegment[] => {
  const segments: LogSegment[] = [];
  events.forEach((event, index) => {
    const previous = segments[segments.length - 1];
    if (!isAnalysisEntry(event)) {
      segments.push({ kind: 'entry', start: index, event });
    } else if (previous?.kind === 'thoughts') {
      previous.events.push(event);
    } else {
      segments.push({ kind: 'thoughts', start: index, events: [event], durationMs: null });
    }
  });
  for (const segment of segments) {
    if (segment.kind !== 'thoughts') continue;
    const begin = timeOf(segment.events[0]);
    const end = timeOf(events[segment.start + segment.events.length]) ?? timeOf(segment.events[segment.events.length - 1]);
    segment.durationMs = begin !== null && end !== null && end > begin ? end - begin : null;
  }
  return segments;
};

/** A one-line disclosure over a run of reasoning entries, so they never push the actions down the page. */
const ThoughtDisclosure: React.FC<{ events: PreparedThinkingLogEvent[]; durationMs: number | null; autoOpen: boolean }> = ({ events, durationMs, autoOpen }) => {
  // Open while it is the newest reasoning of a live run, until the reader decides otherwise.
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? autoOpen;
  const panelId = useId();
  const steps = `${events.length} analysis step${events.length === 1 ? '' : 's'}`;
  const thought = durationMs !== null && durationMs >= 1000 ? `Thought for ${formatRelativeTime(durationMs)}` : 'Thought';
  return (
    <div data-testid="thought-disclosure" className="py-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setChoice(!open)}
        className="-mx-1 flex h-6 items-center gap-1.5 rounded px-1 text-xs text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
      >
        <ChevronRight className={`h-3 w-3 flex-none transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        <span className="font-medium">{thought}</span>{' '}
        <span className="text-slate-400">({steps})</span>
      </button>
      {open && (
        <div id={panelId} className="ml-2 border-l-2 border-slate-200 pl-3">
          {events.map((event, index) => <TerminalLogEntry key={index} event={event} />)}
        </div>
      )}
    </div>
  );
};

interface ThoughtGroupProps {
  /** A todo's name; the untitled group is the whole log and needs no heading. */
  title?: string;
  events: LogEvent[];
  isCompleted: boolean;
  todoId?: string;
  isHighlighted?: boolean;
  /** Whether this group ends the log of a run that is still streaming. */
  streamingTail?: boolean;
}

const ThoughtGroup: React.FC<ThoughtGroupProps> = ({ title, events, isCompleted, todoId, isHighlighted, streamingTail = false }) => {
  const segments = useMemo(() => segmentEvents(events), [events]);
  if (events.length === 0) return null;

  return (
    <div
      className={`transition-all duration-300 ${
        isHighlighted ? 'ring-1 ring-blue-300 ring-offset-1 rounded' : ''
      }`}
      id={todoId ? `thinking-log-${todoId}` : undefined}
      data-todo-id={todoId}
      data-todo-content={title}
    >
      {title && (
        <div className="mt-3 flex items-center gap-2 py-1 first:mt-0">
          {isCompleted ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" aria-hidden="true" />
          ) : (
            <span className="h-3.5 w-3.5 rounded-full border-2 border-blue-400 flex-shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 truncate text-xs font-semibold text-slate-600">{title}</span>
        </div>
      )}

      {/* Log entries - gutter style layout */}
      <div>
        {segments.map((segment, index) => segment.kind === 'entry'
          ? <TerminalLogEntry key={segment.start} event={segment.event} todoContext={undefined} isHighlighted={false} />
          : <ThoughtDisclosure key={segment.start} events={segment.events} durationMs={segment.durationMs} autoOpen={streamingTail && index === segments.length - 1} />)}
      </div>
    </div>
  );
};

const ThinkingLog: React.FC<ThinkingLogProps> = ({
  events,
  todos = [],
  highlightedTodoId,
  streaming = false,
  historyTruncated = false,
  checkpointOutcome,
  emptyMessage,
}) => {
  const preparedEvents = useMemo(() => {
    return markFinalStep(prepareCheckpointEvents(readableThoughts(events), checkpointOutcome), streaming);
  }, [checkpointOutcome, events, streaming]);

  // Group events by todo items if available
  const groupedEvents = useMemo(() => {
    if (todos.length === 0) {
      // No todos, just show all events ungrouped
      return [{ events: preparedEvents, isCompleted: false, todoId: undefined }];
    }

    // For now, create logical groups based on event timing and todo completion
    const groups: ThoughtGroupProps[] = [];

    // Find completed todos and create groups
    const completedTodos = todos.filter(t => t.status === 'completed');
    const inProgressTodo = todos.find(t => t.status === 'in_progress');

    // If we have events but no clear grouping, show them in a single group
    if (completedTodos.length === 0 && !inProgressTodo) {
      return [{ events: preparedEvents, isCompleted: false, todoId: undefined }];
    }

    // Simple strategy: split events roughly equally among completed todos + current
    const totalGroups = completedTodos.length + (inProgressTodo ? 1 : 0);

    if (totalGroups === 0 || preparedEvents.length === 0) {
      return [{ events: preparedEvents, isCompleted: false, todoId: undefined }];
    }

    const eventsPerGroup = Math.ceil(preparedEvents.length / totalGroups);

    completedTodos.forEach((todo, idx) => {
      const start = idx * eventsPerGroup;
      const end = Math.min(start + eventsPerGroup, preparedEvents.length);
      const groupEvents = preparedEvents.slice(start, end);

      if (groupEvents.length > 0) {
        groups.push({
          title: todo.content,
          events: groupEvents,
          isCompleted: true,
          todoId: todo.id
        });
      }
    });

    if (inProgressTodo) {
      const start = completedTodos.length * eventsPerGroup;
      const groupEvents = preparedEvents.slice(start);

      if (groupEvents.length > 0) {
        groups.push({
          title: inProgressTodo.content,
          events: groupEvents,
          isCompleted: false,
          todoId: inProgressTodo.id
        });
      }
    }

    // If no groups were created, show all events
    if (groups.length === 0) {
      return [{ events: preparedEvents, isCompleted: false, todoId: undefined }];
    }

    return groups;
  }, [preparedEvents, todos]);

  if (preparedEvents.length === 0) {
    if (!emptyMessage) return null;
    return (
      <p data-testid="thinking-log-empty" className="m-0 py-2 text-xs italic text-slate-400">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div id="thinking-log-section" className="min-w-0 overflow-hidden">
      {/* The surface above owns the log's single header (its label, step count and view switch). */}
      {historyTruncated && (
        <p role="note" className="mb-3 text-xs text-slate-500">
          {HISTORY_TRUNCATED_NOTICE} The oldest messages may be missing.
        </p>
      )}

      {/* Grouped Events - terminal style log feed */}
      <div className="space-y-1 min-w-0">
        {groupedEvents.map((group, index) => (
          <ThoughtGroup
            key={group.todoId || index}
            title={group.title}
            events={group.events}
            isCompleted={group.isCompleted}
            todoId={group.todoId}
            isHighlighted={highlightedTodoId === group.todoId}
            streamingTail={streaming && index === groupedEvents.length - 1}
          />
        ))}
      </div>

    </div>
  );
};

export default ThinkingLog;
