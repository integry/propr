import type { ConversationEvent, LiveOutputPosition } from '@propr/shared';
import { liveOutputKey, liveOutputMetaKey } from '@propr/core';
import { createClaudeStreamProjection } from '../routes/liveDetailsCodexParser.js';
import { detectStoredOutputFormat } from '../routes/liveDetailsStoredOutputFormat.js';
import { idSegment } from './liveEventIds.js';
import { selectLiveEvents } from './liveEventSelection.js';
import {
  createRedisOutputProjection,
  parseVibeTranscript,
  type NativeGoalProjection,
  type ParsedRedisOutput,
} from './redisOutputParser.js';
import { claudeNativeGoalRecord, projectClaudeNativeGoalRecord, type ClaudeNativeGoalRecord } from './agentStreamProjection.js';

/**
 * Readers of a task's append-only live output (see core's liveOutputLog): they
 * fetch only bytes they have not seen and project them record by record, so a
 * live update costs what the new output costs, not what the whole run costs.
 */

export interface LiveOutputRedis {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const READ_LIVE_OUTPUT_SCRIPT = `
local meta = redis.call('hmget', KEYS[2], 'base', 'epoch', 'start', 'head', 'generation', 'envelopes')
local base = tonumber(meta[1] or '0') or 0
local length = redis.call('strlen', KEYS[1])
-- Metadata-free workers replace whole snapshots, including at the retention ceiling.
local from = meta[2] and tonumber(ARGV[1]) or 0
if from < base or from > base + length then from = base end
local epoch = meta[2] or 'legacy'
if meta[5] then epoch = meta[5] .. ':' .. epoch end
local text = ''
if from - base < length then text = redis.call('getrange', KEYS[1], from - base, length - 1) end
return { tostring(base), epoch, tostring(tonumber(meta[3] or '0') or 0), meta[4] or '', tostring(from), text, tostring(length), tostring(tonumber(meta[6] or '0') or 0), from == base and (redis.call('hget', KEYS[2], 'openCodeTools') or '{}') or '{}' }
`;

export interface LiveOutputRead {
  /** Generation plus execution counter; changes on reset or recreation after expiry. */
  epoch: string;
  /** Absolute offset of the first byte still retained. */
  base: number;
  /** Absolute offset just past the retained log; offsets beyond it require resync. */
  end: number;
  /** Absolute offset where this execution began, and its first record (kept even once trimmed). */
  start: number;
  head: string;
  /** How many of this execution's JSON records were trimmed: the ordinal of the first retained one. */
  envelopes: number;
  /** Offset of `text`: clamped to base after trimming or a request beyond end; zero for legacy snapshots. */
  from: number;
  text: string;
  /** Tool IDs in trimmed records, needed to skip cumulative duplicates on a fresh read. */
  openCodeTools?: { uses?: Record<string, boolean>; results?: Record<string, boolean> };
}

export async function readLiveOutput(redis: LiveOutputRedis, taskId: string, from = 0): Promise<LiveOutputRead | null> {
  const [base, epoch, start, head, readFrom, text, length, envelopes, openCodeTools] = await redis.eval(READ_LIVE_OUTPUT_SCRIPT, {
    keys: [liveOutputKey(taskId), liveOutputMetaKey(taskId)],
    arguments: [String(from)],
  }) as string[];
  if (Number(length) === 0 && epoch === 'legacy') return null;
  return {
    epoch, base: Number(base), end: Number(base) + Number(length), start: Number(start), head,
    openCodeTools: JSON.parse(openCodeTools || '{}'),
    envelopes: Number(envelopes ?? 0) || 0, from: Number(readFrom), text,
  };
}

export interface LiveProjectionSnapshot {
  todos: ParsedRedisOutput['todos'];
  currentTask: string | null;
  tokenUsage: ParsedRedisOutput['tokenUsage'];
  nativeGoal: NativeGoalProjection | null;
}

type LiveEvent = ConversationEvent & { id: string };

interface Projection {
  /** `ordinal` numbers the execution's JSON records, the basis of synthetic timestamps. */
  feed(line: string, offset: number, ordinal: number): LiveEvent[];
  pending(): LiveEvent | null;
  snapshot(): LiveProjectionSnapshot;
}

const SYNTHETIC_TIMESTAMP_STEP_MS = 1000;
/** A JSON record; the append script counts trimmed ones by the same rule. */
const ENVELOPE = /^[ \t\r]*\{/;
/** Bounds diagnostic preamble without committing to a provider parser. */
const MAX_PREAMBLE_RECORDS = 200;
const MAX_PREAMBLE_BYTES = 256 * 1024;

interface Entry { line: string; offset: number; ordinal: number }

/**
 * Projects one execution's records as they arrive. Event IDs derive from the
 * offset (from the execution's start) of the record that produced them, so the
 * same event gets the same ID from a full read, an incremental read, a read
 * after old output was trimmed, or a re-published snapshot.
 */
export class LiveOutputProjector {
  private projection: Projection | null = null;
  private preamble: Entry[] = [];
  private preambleBytes = 0;
  /** Offset just past the last complete record consumed. */
  offset: number;
  /** Ordinal of the next JSON record. */
  private envelope = 0;
  /** The record at absolute `offset` has JSON-record ordinal `envelopes` (records before it were trimmed). */
  private readonly retained: { offset: number; envelopes: number; openCodeTools?: LiveOutputRead['openCodeTools'] };

  private readonly taskId: string;
  /** Execution identity namespacing event IDs: the read's epoch, scoped by execution for legacy output. */
  readonly epoch: string;
  private readonly executionStartTimestamp: string | null;
  /** Absolute offset where the execution's output begins; event keys are relative to it. */
  readonly start: number;

  constructor(options: {
    taskId: string;
    epoch: string;
    offset: number;
    start?: number;
    executionStartTimestamp?: string | null;
    retained?: { offset: number; envelopes: number; openCodeTools?: LiveOutputRead['openCodeTools'] };
  }) {
    this.taskId = options.taskId;
    this.epoch = options.epoch;
    this.offset = options.offset;
    this.start = options.start ?? 0;
    this.executionStartTimestamp = options.executionStartTimestamp ?? null;
    this.retained = options.retained ?? { offset: this.start, envelopes: 0 };
  }

  /**
   * Consumes the complete records of `text`, which begins at absolute `from`.
   * A trailing partial record is left for the next read.
   */
  feed(text: string, from: number): LiveEvent[] {
    // Whole transcripts must bypass JSONL framing, including a final ] without a newline.
    // Their events are numbered by index, so only an untrimmed read from the
    // execution's first byte may number them: a bounded tail would reuse the
    // indexes of the messages it no longer holds.
    if (!this.projection && this.preamble.length === 0 && from === this.start && this.retained.offset <= this.start) {
      const transcript = parseVibeTranscript(text, { executionStartTimestamp: this.executionStartTimestamp });
      if (transcript) {
        this.projection = this.wholeOutputProjection(transcript);
        this.offset = from + Buffer.byteLength(text);
        return this.projection.feed(text, from, this.envelope);
      }
    }
    const entries: Entry[] = [];
    let offset = from;
    const boundary = text.lastIndexOf('\n') + 1;
    if (boundary > 0) {
      for (const line of text.slice(0, boundary - 1).split('\n')) {
        entries.push(this.entry(line, offset));
        offset += Buffer.byteLength(line) + 1;
      }
    }
    // A final JSON record is complete even before its newline arrives: no append
    // can turn one JSON object into another. Anything else waits for its newline.
    const remainder = text.slice(boundary);
    if (isCompleteJsonRecord(remainder)) {
      entries.push(this.entry(remainder, offset));
      offset += Buffer.byteLength(remainder);
    }
    if (entries.length === 0) return [];
    this.offset = offset;
    if (!this.projection) return this.decide(entries);
    return entries.flatMap(entry => this.projection!.feed(entry.line, entry.offset, entry.ordinal));
  }

  /**
   * Numbers JSON records from the execution's start, continuing past trimmed
   * ones, so a record's synthetic timestamp does not depend on what was read.
   */
  private entry(line: string, offset: number): Entry {
    if (offset >= this.retained.offset) this.envelope = Math.max(this.envelope, this.retained.envelopes);
    return { line, offset, ordinal: ENVELOPE.test(line) ? this.envelope++ : this.envelope };
  }

  /**
   * Records before the provider can be identified (container banners, Claude's
   * init record) are held and replayed once it can, so a full read and any
   * sequence of incremental reads choose the same parser.
   */
  private decide(entries: Entry[]): LiveEvent[] {
    const events: LiveEvent[] = [];
    for (const entry of entries) {
      if (this.projection) {
        events.push(...this.projection.feed(entry.line, entry.offset, entry.ordinal));
        continue;
      }
      this.preamble.push(entry);
      this.preambleBytes += Buffer.byteLength(entry.line) + 1;
      const format = detectStoredOutputFormat(entry.line);
      if (format === 'unknown') {
        if (this.preamble.length >= MAX_PREAMBLE_RECORDS || this.preambleBytes >= MAX_PREAMBLE_BYTES) {
          // Plain startup diagnostics produce no events in either parser. Keep
          // envelopes (including init) to replay once the provider identifies itself.
          this.preamble = this.preamble.filter(held => ENVELOPE.test(held.line));
          this.preambleBytes = this.preamble.reduce((bytes, held) => bytes + Buffer.byteLength(held.line) + 1, 0);
        }
        continue;
      }
      this.projection = format === 'claude' ? this.claudeProjection() : this.genericProjection();
      for (const held of this.preamble) events.push(...this.projection.feed(held.line, held.offset, held.ordinal));
      this.preamble = [];
      this.preambleBytes = 0;
    }
    return events;
  }

  /** What a reader shows while the provider is still unidentified, without committing to a parser. */
  private provisional(): Projection {
    const projection = this.genericProjection();
    for (const entry of this.preamble) projection.feed(entry.line, entry.offset, entry.ordinal);
    return projection;
  }

  /** Events of held records, for a full read that ends before the provider is identified. */
  heldEvents(): LiveEvent[] {
    if (this.projection || this.preamble.length === 0) return [];
    const projection = this.genericProjection();
    return this.preamble.flatMap(entry => projection.feed(entry.line, entry.offset, entry.ordinal));
  }

  /** Where this projection has read to; legacy output restarts its offsets with every snapshot, so it has none. */
  position(): LiveOutputPosition | null {
    return this.epoch === 'legacy' || this.epoch.startsWith('legacy:') ? null : { epoch: this.epoch, offset: this.offset };
  }

  pending(): LiveEvent | null {
    if (!this.projection) return this.preamble.length > 0 ? this.provisional().pending() : null;
    return this.projection.pending();
  }

  snapshot(): LiveProjectionSnapshot {
    if (!this.projection) {
      return this.preamble.length > 0
        ? this.provisional().snapshot()
        : { todos: [], currentTask: null, tokenUsage: null, nativeGoal: null };
    }
    return this.projection.snapshot();
  }

  private id(event: ConversationEvent, key: string): string {
    const prefix = `live:${idSegment(this.taskId)}:redis:${idSegment(this.epoch)}`;
    const externalId = 'id' in event && typeof (event as { id?: unknown }).id === 'string' && (event as { id: string }).id
      ? (event as { id: string }).id
      : null;
    return externalId
      ? `${prefix}:${idSegment(event.type)}:external:${idSegment(externalId)}`
      : `${prefix}:${key}`;
  }

  /** A `slot` is the event's stable source position within its record; otherwise events are numbered in emission order. */
  private withIds(entries: Array<{ event: ConversationEvent; key: string; slot?: number }>): LiveEvent[] {
    const perKey = new Map<string, number>();
    return entries.map(({ event, key, slot }) => {
      const index = perKey.get(key) ?? 0;
      perKey.set(key, index + 1);
      return { ...event, id: this.id(event, `${key}:${slot ?? index}`) };
    });
  }

  /*
   * Parsers release events once emitted: a watcher keeps its projector for the
   * whole run, and a reader that wants every event collects what feed() returns.
   */
  private genericProjection(): Projection {
    const projection = createRedisOutputProjection({ executionStartTimestamp: this.executionStartTimestamp, retainEvents: false });
    let seeded = false;
    return {
      feed: (line, offset, ordinal) => {
        if (!seeded && offset >= this.retained.offset) {
          projection.seedOpenCodeTools(this.retained.openCodeTools ?? {});
          seeded = true;
        }
        return this.withIds(projection.feed(line, String(offset - this.start), ordinal).events);
      },
      pending: () => {
        const pending = projection.pendingEvent();
        return pending ? { ...pending.event, id: this.id(pending.event, `${pending.key}:0`) } : null;
      },
      snapshot: () => {
        const { todos, currentTask, tokenUsage, nativeGoal } = projection.metadata();
        return { todos, currentTask, tokenUsage, nativeGoal: nativeGoal ?? null };
      },
    };
  }

  private claudeProjection(): Projection {
    const projection = createClaudeStreamProjection({ retainEvents: false });
    const startMs = this.executionStartTimestamp ? new Date(this.executionStartTimestamp).getTime() : NaN;
    let goalRecord: ClaudeNativeGoalRecord | null = null;
    return {
      feed: (line, offset, ordinal) => {
        // Container entrypoints print plain text before Claude's first envelope.
        if (!ENVELOPE.test(line)) return [];
        const stamped = withSyntheticTimestamp(line, startMs, ordinal);
        goalRecord = claudeNativeGoalRecord(line) ?? goalRecord;
        // Whether a tool result is followed by a subagent completion depends on
        // an earlier (possibly trimmed) Task invocation, so IDs use source slots.
        const key = String(offset - this.start);
        return this.withIds(projection.feed(stamped).map(event => ({ event: event as unknown as ConversationEvent, key, slot: projection.slot(event) })));
      },
      pending: () => null,
      snapshot: () => {
        const { todos, currentTask, tokenUsage } = projection.metadata();
        return {
          todos: todos as LiveProjectionSnapshot['todos'],
          currentTask,
          tokenUsage: tokenUsage as LiveProjectionSnapshot['tokenUsage'],
          nativeGoal: goalRecord ? projectClaudeNativeGoalRecord(goalRecord, tokenUsage) : null,
        };
      },
    };
  }

  /** Vibe publishes whole transcripts, so each read re-projects the snapshot it has. */
  private wholeOutputProjection(parsed: ParsedRedisOutput): Projection {
    let events: ConversationEvent[] | null = parsed.events;
    const snapshot: LiveProjectionSnapshot = {
      todos: parsed.todos,
      currentTask: parsed.currentTask,
      tokenUsage: parsed.tokenUsage,
      nativeGoal: parsed.nativeGoal ?? null,
    };
    return {
      feed: () => {
        if (!events) return [];
        const emitted = events;
        events = null;
        return this.withIds(emitted.map((event, index) => ({ event, key: `vibe:${index}` })));
      },
      pending: () => null,
      snapshot: () => snapshot,
    };
  }
}

function isCompleteJsonRecord(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function withSyntheticTimestamp(line: string, startMs: number, index: number): string {
  if (Number.isNaN(startMs)) return line;
  try {
    const envelope = JSON.parse(line) as { timestamp?: unknown };
    if (envelope.timestamp) return line;
    envelope.timestamp = new Date(startMs + index * SYNTHETIC_TIMESTAMP_STEP_MS).toISOString();
    return JSON.stringify(envelope);
  } catch {
    return line;
  }
}

export interface LiveOutputProjectionResult extends LiveProjectionSnapshot {
  events: LiveEvent[];
  /** Raw events of the retained output left out by {@link selectLiveEvents}. */
  omittedEventCount: number;
  /**
   * Earlier output of this execution was trimmed from Redis. How many events it
   * held is unknown, so it is not part of `omittedEventCount`.
   */
  truncated: boolean;
  /** Where this read ended, when the output has ordered offsets. */
  liveOutputPosition?: LiveOutputPosition;
  projector: LiveOutputProjector;
}

/**
 * Metadata-free output has no execution counter: every execution reads as
 * epoch `legacy`, so offset-based IDs would repeat across executions. Scoping
 * them by the execution that wrote the output keeps them distinct.
 */
function liveOutputIdentity(read: Pick<LiveOutputRead, 'epoch'>, legacyExecution: string | null | undefined): string {
  return read.epoch === 'legacy' && legacyExecution ? `legacy:${legacyExecution}` : read.epoch;
}

/** Everything retained for the current execution, projected from its first record. */
export async function projectLiveOutput(
  redis: LiveOutputRedis,
  taskId: string,
  executionStartTimestamp: string | null = null,
  { selectEvents = true, resolveLegacyExecution }: {
    selectEvents?: boolean;
    /** Identifies the execution that wrote metadata-free output; see {@link liveOutputIdentity}. */
    resolveLegacyExecution?: () => Promise<string | null>;
  } = {},
): Promise<LiveOutputProjectionResult | null> {
  const read = await readLiveOutput(redis, taskId, 0);
  if (!read) return null;
  const legacyExecution = read.epoch === 'legacy' ? await resolveLegacyExecution?.() : null;
  return projectLiveOutputRead(read, taskId, executionStartTimestamp, { selectEvents, legacyExecution });
}

/** Project exactly the snapshot read, without another Redis read across an await. */
export function projectLiveOutputRead(
  read: LiveOutputRead,
  taskId: string,
  executionStartTimestamp: string | null = null,
  { selectEvents = true, legacyExecution }: { selectEvents?: boolean; legacyExecution?: string | null } = {},
): LiveOutputProjectionResult {
  const epoch = liveOutputIdentity(read, legacyExecution);
  const projector = new LiveOutputProjector({
    taskId, epoch, offset: read.from, start: read.start, executionStartTimestamp,
    retained: { offset: read.base, envelopes: read.envelopes, openCodeTools: read.openCodeTools },
  });
  const truncated = read.base > read.start;
  // The first record identifies the provider; it survives trimming in `head`.
  const events = truncated && read.head ? projector.feed(`${read.head}\n`, read.start) : [];
  for (const event of projector.feed(read.text, read.from)) events.push(event);
  for (const event of projector.heldEvents()) events.push(event);
  const pending = projector.pending();
  const all = pending ? [...events, pending] : events;
  const selected = selectEvents ? selectLiveEvents(all) : { events: all, omittedEventCount: 0 };
  const liveOutputPosition = projector.position() ?? undefined;
  return { ...projector.snapshot(), events: selected.events, omittedEventCount: selected.omittedEventCount, truncated, liveOutputPosition, projector };
}
