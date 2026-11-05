import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import logger from '../../../utils/logger.js';
import { MAX_PROVIDER_OUTPUT_BYTES } from './boundedProviderOutput.js';

/**
 * A task's live agent output in Redis is an append-only log, so writers send
 * only new records and readers fetch only the bytes they have not seen yet.
 *
 *   agent:output:<task>       the retained output (a byte string)
 *   agent:output:<task>:meta  hash: `base` absolute offset of the first retained
 *                             byte, `epoch` bumped whenever an execution starts
 *                             over, `start` that execution's absolute offset,
 *                             `head` its first record, `generation` a unique identity
 *                             assigned when the log is recreated, `envelopes` how many
 *                             of the execution's JSON records were trimmed (the ordinal
 *                             of the first retained one), `publication:<writer>` the
 *                             last batch each writer committed
 *
 * Within a generation offsets only grow: a reader that remembers one can tell
 * whether its next bytes are still retained. When the output passes the ceiling
 * the oldest records are dropped at a record boundary (the first record, which
 * identifies the provider format, is kept in `head`). A buffered assistant
 * message still arriving across that boundary is kept from its first delta,
 * the record readers identify it by, unless its deltas alone exceed an eighth
 * of the ceiling.
 */
export const LIVE_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
export const LIVE_OUTPUT_TTL_SECONDS = 3600;
/**
 * Most output a writer holds while its publication fails or falls behind. Past
 * it the writer refuses further output and reports the overflow. Display
 * sinks may drop it; durable sinks must fail instead of losing accepted work.
 */
export const LIVE_OUTPUT_MAX_QUEUED_BYTES = 16 * 1024 * 1024;

export const liveOutputKey = (taskId: string): string => `agent:output:${taskId}`;
export const liveOutputMetaKey = (taskId: string): string => `agent:output:${taskId}:meta`;

/**
 * KEYS: data, meta. ARGV: chunk, maximum bytes, ttl seconds, mode, generation
 * candidate, writer, batch sequence, origin offset, origin envelopes, origin
 * head. mode `reset` starts a new execution (new epoch) before appending;
 * `replace` swaps in a whole snapshot of the same execution (providers that
 * cannot stream records), so readers resynchronize without a new epoch. A
 * snapshot whose oldest records were dropped (see {@link LiveOutputOrigin})
 * starts that far into the execution, just like a trimmed log. A writer's
 * batches commit in sequence order, so a batch at or below its last committed
 * sequence is a retry of a write whose reply was lost, and is not applied again.
 */
export const APPEND_LIVE_OUTPUT_SCRIPT = `
-- Whether a record before the cut leaves a buffered assistant message open:
-- 0 when it completes one, 2 when it is one of its deltas, 1 when readers skip
-- it. Mirrors what the API's generic parser (redisOutputParser) buffers: stream
-- deltas and OpenCode text parts, until a tool or error record.
local tools = { tool_use = true, tool = true, tool_call = true, tool_result = true, tool_response = true }
-- Carry only tool identities across a trim, never their bodies. A fresh parser
-- needs the same deduplication evidence as the running parser.
local function toolState()
    local raw = redis.call('hget', KEYS[2], 'openCodeTools')
    return raw and cjson.decode(raw) or { uses = {}, results = {} }
end
local function visitTools(record, seen)
    if not string.find(record, '"tool', 1, true) then return false end
    local ok, event = pcall(cjson.decode, record)
    if not ok or type(event) ~= 'table' then return false end
    -- Session-qualified and part-based OpenCode records take this parser route.
    if not (event.sessionID or event.sessionId or event.session_id or event.callID or event.state or event.part or event.parts) then return false end
    local emitted = false
    local function visit(source)
        if type(source) ~= 'table' or type(source.type) ~= 'string' then return end
        local kind = string.lower(source.type)
        if not tools[kind] then return end
        local id = source.tool_id or source.callID or source.id
        if id == cjson.null then id = nil end
        local result = kind == 'tool_result' or kind == 'tool_response'
        local ids = result and seen.results or seen.uses
        if id and ids[id] then return end
        emitted = true
        if id then ids[id] = true end
        if kind == 'tool' and type(source.state) == 'table'
            and (source.state.status == 'completed' or source.state.status == 'error') and id then
            seen.results[id] = true
        end
    end
    if not event.part then visit(event) end
    visit(event.part)
    for _, part in ipairs(type(event.parts) == 'table' and event.parts or {}) do visit(part) end
    return emitted
end
local function continuesMessage(record, emittedTool)
    if not string.find(record, '^[ \\t\\r]*{') then return 1 end
    local decoded, event = pcall(cjson.decode, record)
    if not decoded then return 1 end
    if type(event) ~= 'table' then return 0 end
    local kind = type(event.type) == 'string' and string.lower(event.type) or ''
    if emittedTool or kind == 'error' or (event.error ~= nil and event.error ~= cjson.null) then return 0 end
    local parts = type(event.parts) == 'table' and event.parts or {}
    if type(event.part) == 'table' then parts = { event.part, unpack(parts) } end
    -- Tool parts with no emitted event are cumulative duplicates; they do not
    -- flush the parser's pending message. Non-OpenCode tools still complete it.
    if tools[kind] then
        if not (event.sessionID or event.sessionId or event.session_id or event.callID or event.state or event.part or event.parts) then return 0 end
        if #parts == 0 then return 1 end
    end
    if event.delta == true or type(event.delta) == 'string' or kind == 'delta' or #parts > 0 then return 2 end
    return 0
end
local mode = ARGV[4]
local publication = nil
if ARGV[6] and ARGV[6] ~= '' then
    publication = 'publication:' .. ARGV[6]
    if tonumber(redis.call('hget', KEYS[2], publication) or '0') >= tonumber(ARGV[7]) then
        return redis.call('strlen', KEYS[1])
    end
end
-- The counter can restart after expiry. A fresh identity distinguishes that
-- log from all prior generations, even if its offsets and epoch are identical.
if redis.call('exists', KEYS[1]) == 0 or redis.call('hexists', KEYS[2], 'generation') == 0 then
    redis.call('hset', KEYS[2], 'generation', ARGV[5])
end
if mode == 'reset' or mode == 'replace' then
    local previous = redis.call('strlen', KEYS[1])
    local previousStart = tonumber(redis.call('hget', KEYS[2], 'start') or '-1')
    redis.call('del', KEYS[1])
    local base = redis.call('hincrby', KEYS[2], 'base', previous)
    -- A snapshot replaces the same execution's output, so its events keep their IDs.
    if mode == 'reset' then redis.call('hincrby', KEYS[2], 'epoch', 1) end
    -- Records keep their offsets from the execution's start when the snapshot
    -- dropped older ones. The start must still move, or a reader would take
    -- the new snapshot for an append to the one it read.
    local origin = tonumber(ARGV[8] or '0') or 0
    if origin > 0 and base - origin <= previousStart then
        base = redis.call('hincrby', KEYS[2], 'base', previousStart + origin + 1 - base)
    end
    redis.call('hset', KEYS[2], 'start', base - origin)
    redis.call('hdel', KEYS[2], 'head', 'envelopes', 'openCodeTools')
    if origin > 0 then redis.call('hset', KEYS[2], 'head', ARGV[10], 'envelopes', ARGV[9]) end
end
if redis.call('hexists', KEYS[2], 'epoch') == 0 then
    redis.call('hset', KEYS[2], 'epoch', 0)
    redis.call('hsetnx', KEYS[2], 'base', 0)
    redis.call('hsetnx', KEYS[2], 'start', 0)
end
local length = redis.call('append', KEYS[1], ARGV[1])
if redis.call('hexists', KEYS[2], 'head') == 0 then
    local first = redis.call('getrange', KEYS[1], 0, 65535)
    local boundary = string.find(first, '\\n', 1, true)
    if boundary then
        redis.call('hset', KEYS[2], 'head', string.sub(first, 1, boundary - 1))
    elseif length > 65536 then
        redis.call('hset', KEYS[2], 'head', '')
    end
end
local maximum = tonumber(ARGV[2])
if length > maximum then
    local keep = math.floor(maximum * 3 / 4)
    local tail = redis.call('getrange', KEYS[1], length - keep, -1)
    local boundary = string.find(tail, '\\n', 1, true)
    if boundary then
        tail = string.sub(tail, boundary + 1)
        -- Readers identify a buffered assistant message by its first delta, so a
        -- message still arriving across the cut is retained from that record on.
        local cut = length - string.len(tail)
        local from = math.max(0, cut - math.floor((maximum - keep) / 2))
        local seen = toolState()
        local completions = {}
        local prefix = redis.call('getrange', KEYS[1], 0, cut - 1)
        local position = 0
        for record in string.gmatch(prefix, '([^\\n]*)\\n') do
            local emitted = visitTools(record, seen)
            position = position + string.len(record) + 1
            if emitted then completions[position] = true end
        end
        -- Reversed, the records before the cut read from the nearest one backwards.
        local before = string.reverse(redis.call('getrange', KEYS[1], from, cut - 1))
        local at = 1
        local message = 0
        while true do
            local finish = string.find(before, '\\n', at + 1, true)
            local record = string.reverse(string.sub(before, at + 1, (finish or 0) - 1))
            -- The record the window begins in is read whole. Unless it completes
            -- the message, the message is longer than the ceiling allows, and
            -- is cut where it was.
            local whole = finish or from == 0
            while not finish and from > 0 do
                local step = math.max(0, from - 65536)
                local chunk = redis.call('getrange', KEYS[1], step, from - 1)
                local last = string.find(string.reverse(chunk), '\\n', 1, true)
                record = (last and string.sub(chunk, string.len(chunk) - last + 2) or chunk) .. record
                from = last and 0 or step
            end
            local continues = continuesMessage(record, completions[cut - at + 1])
            if continues == 0 then break end
            if not whole then message = 0 break end
            if continues == 2 then message = (finish or string.len(before) + 1) - 1 end
            if not finish then break end
            at = finish
        end
        if message > 0 then tail = redis.call('getrange', KEYS[1], cut - message, -1) end
    end
    -- Readers number JSON records to synthesize timestamps; count the trimmed
    -- ones so the retained records keep their ordinals.
    local dropped = redis.call('getrange', KEYS[1], 0, length - string.len(tail) - 1)
    local seen = toolState()
    for record in string.gmatch(dropped, '([^\\n]*)\\n') do visitTools(record, seen) end
    redis.call('hset', KEYS[2], 'openCodeTools', cjson.encode(seen))
    local envelopes = 0
    if string.find(dropped, '^[ \\t\\r]*{') then envelopes = 1 end
    for _ in string.gmatch(dropped, '\\n[ \\t\\r]*{') do envelopes = envelopes + 1 end
    redis.call('hincrby', KEYS[2], 'envelopes', envelopes)
    redis.call('set', KEYS[1], tail)
    redis.call('hincrby', KEYS[2], 'base', length - string.len(tail))
    length = string.len(tail)
end
if publication then redis.call('hset', KEYS[2], publication, ARGV[7]) end
redis.call('expire', KEYS[1], tonumber(ARGV[3]))
redis.call('expire', KEYS[2], tonumber(ARGV[3]))
return length
`;

export type LiveOutputWriteMode = 'append' | 'reset' | 'replace';

/**
 * Where a snapshot begins within its execution's output once its oldest
 * records were dropped: `offset` bytes in, after `envelopes` JSON records, the
 * first of which is `head`. Readers then number its records as if nothing had
 * been dropped, exactly as they do for a log trimmed at the ceiling.
 */
export interface LiveOutputOrigin {
    offset: number;
    envelopes: number;
    head: string;
}

/** Longest first record kept as `head`; the append script reads the same window. */
const MAX_HEAD_BYTES = 65535;
/** A JSON record; the append script counts trimmed ones by the same rule. */
const ENVELOPE = /^[ \t\r]*\{/;

/** The origin of a snapshot whose records before it, `discarded`, were dropped. */
export function liveOutputOrigin(discarded: string): LiveOutputOrigin | undefined {
    if (!discarded) return undefined;
    const lines = discarded.split('\n');
    const head = lines.length > 1 && Buffer.byteLength(lines[0]) <= MAX_HEAD_BYTES ? lines[0] : '';
    return { offset: Buffer.byteLength(discarded), envelopes: lines.filter(line => ENVELOPE.test(line)).length, head };
}

/** A queued batch's identity, kept across retries: `sequence` grows by one per batch of `writer`. */
export interface LiveOutputPublication {
    writer: string;
    sequence: number;
}

export async function writeLiveOutput(
    redis: Pick<Redis, 'eval'>,
    taskId: string,
    chunk: string,
    { mode = 'append', maximumBytes = LIVE_OUTPUT_MAX_BYTES, publication, origin }: {
        mode?: LiveOutputWriteMode;
        maximumBytes?: number;
        /** Makes a retry of a committed batch (whose reply was lost) a no-op. */
        publication?: LiveOutputPublication;
        /** `reset` and `replace` only: where the chunk begins within the execution. */
        origin?: LiveOutputOrigin;
    } = {},
): Promise<number> {
    return Number(await redis.eval(
        APPEND_LIVE_OUTPUT_SCRIPT, 2, liveOutputKey(taskId), liveOutputMetaKey(taskId),
        chunk, String(maximumBytes), String(LIVE_OUTPUT_TTL_SECONDS), mode, randomUUID(),
        publication?.writer ?? '', String(publication?.sequence ?? 0),
        String(origin?.offset ?? 0), String(origin?.envelopes ?? 0), origin?.head ?? '',
    ));
}

/**
 * The bytes a writer has accepted but not yet had acknowledged. Output that
 * would take it past the maximum is refused, as is everything after it: the
 * writer can no longer deliver the execution's output in order, so the
 * overflow is reported once for the owner to handle according to its sink.
 */
export class LiveOutputBacklog {
    private bytes = 0;
    private failure: Error | null = null;

    constructor(
        private readonly maximumBytes = LIVE_OUTPUT_MAX_QUEUED_BYTES,
        private readonly onOverflow?: (error: Error) => void,
        private readonly context: Record<string, unknown> = {},
    ) {}

    get overflow(): Error | null { return this.failure; }

    reserve(bytes: number): boolean {
        if (this.failure) return false;
        if (this.bytes + bytes <= this.maximumBytes) {
            this.bytes += bytes;
            return true;
        }
        this.failure = new Error(`Live output publication fell more than ${this.maximumBytes} bytes behind`);
        logger.warn({ ...this.context, maximumBytes: this.maximumBytes }, 'Live output publication fell behind; refusing further output');
        this.onOverflow?.(this.failure);
        return false;
    }

    release(bytes: number): void { this.bytes -= bytes; }
}

export interface LiveOutputLogOptions {
    /** Start a new execution: the first write replaces whatever an earlier one left. */
    reset?: boolean;
    /** Applied to whole records only, so escape sequences are never split. */
    transformRecord?: (record: string) => string;
    flushIntervalMs?: number;
    redis?: Redis;
    /**
     * Longest record, in bytes without its newline, that is published. A longer
     * one is dropped whole rather than buffered or split into fragments. Defaults
     * to the bound the executor's own record buffer applies to provider output.
     */
    maximumRecordBytes?: number;
    /** Most unpublished output held; see {@link LIVE_OUTPUT_MAX_QUEUED_BYTES}. */
    maximumQueuedBytes?: number;
    /** Called once when unpublished output passes the maximum; later output is refused. */
    onOverflow?: (error: Error) => void;
}

/** A source's unfinished record, or `oversized` while one is discarded up to its newline. */
interface PartialRecord { text: string; bytes: number; oversized: boolean; }

/**
 * Streams one process's output into the task's live log, one complete record
 * at a time. Partial records wait for their newline (or for close()). Each
 * source (stdout, stderr) is framed on its own, so a record of one is never
 * completed by a newline of the other. A record longer than the maximum is
 * dropped as it grows, so each source buffers at most that much. Unpublished
 * output is bounded too (see {@link LiveOutputBacklog}).
 */
export class LiveOutputLog {
    private readonly redis: Redis;
    private readonly ownsRedis: boolean;
    private readonly partials = new Map<string, PartialRecord>();
    private pending = '';
    private pendingBytes = 0;
    private readonly writes: Array<{ chunk: string; bytes: number; mode: 'append' | 'replace'; sequence: number; origin?: LiveOutputOrigin }> = [];
    private readonly backlog: LiveOutputBacklog;
    private readonly writer = randomUUID();
    private sequence = 0;
    private resetPending: boolean;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushPromise: Promise<void> = Promise.resolve();
    private closed = false;
    private finished = false;
    private closePromise: Promise<void> | null = null;

    constructor(private readonly taskId: string, private readonly options: LiveOutputLogOptions = {}) {
        this.resetPending = options.reset === true;
        this.backlog = new LiveOutputBacklog(options.maximumQueuedBytes, options.onOverflow, { taskId });
        this.ownsRedis = !options.redis;
        this.redis = options.redis ?? new Redis({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: 1,
        });
        this.redis.on?.('error', error => logger.debug({ error: error.message }, 'Live output Redis connection error'));
    }

    append(chunk: string, source = 'stdout'): void {
        if (this.closed || this.backlog.overflow || !chunk) return;
        const maximum = this.options.maximumRecordBytes ?? MAX_PROVIDER_OUTPUT_BYTES;
        const partial = this.partials.get(source) ?? { text: '', bytes: 0, oversized: false };
        let records = '';
        for (let start = 0; start < chunk.length;) {
            const boundary = chunk.indexOf('\n', start);
            const end = boundary < 0 ? chunk.length : boundary;
            if (!partial.oversized) {
                const piece = chunk.slice(start, end);
                partial.bytes += Buffer.byteLength(piece);
                if (partial.bytes > maximum) {
                    partial.text = '';
                    partial.oversized = true;
                    logger.warn({ taskId: this.taskId, source, maximumBytes: maximum }, 'Dropping an oversized live output record');
                } else partial.text += piece;
            }
            if (boundary < 0) break;
            // The newline ends the record; a dropped one resumes framing here.
            if (!partial.oversized) records += `${partial.text}\n`;
            partial.text = '';
            partial.bytes = 0;
            partial.oversized = false;
            start = boundary + 1;
        }
        this.partials.set(source, partial);
        if (records) this.queue(records);
    }

    /**
     * Publishes a whole snapshot in place of the previous one (providers that
     * cannot stream records). `discarded` is the output before the snapshot
     * that it no longer holds, so its records keep their offsets.
     */
    replace(snapshot: string, { discarded = '' }: { discarded?: string } = {}): void {
        if (this.closed || this.backlog.overflow) return;
        // The snapshot holds all of the execution's output, so it supersedes
        // queued writes. The head may already be in flight, so it stays.
        this.backlog.release(this.pendingBytes);
        this.pending = '';
        this.pendingBytes = 0;
        for (const superseded of this.writes.splice(1)) this.backlog.release(superseded.bytes);
        const chunk = this.transform(snapshot);
        const bytes = Buffer.byteLength(chunk);
        if (!this.backlog.reserve(bytes)) return;
        const origin = liveOutputOrigin(this.transform(discarded));
        this.writes.push({ chunk, bytes, mode: 'replace', sequence: ++this.sequence, ...(origin ? { origin } : {}) });
        void this.flush();
    }

    flush(): Promise<void> {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.enqueuePending();
        if (this.resetPending && this.writes.length === 0) this.writes.push({ chunk: '', bytes: 0, mode: 'append', sequence: ++this.sequence });
        this.flushPromise = this.flushPromise.then(async () => {
            while (this.writes.length > 0) {
                const write = this.writes[0];
                try {
                    if (this.ownsRedis && this.redis.status === 'end') await this.redis.connect();
                    await writeLiveOutput(this.redis, this.taskId, write.chunk, {
                        mode: this.resetPending ? 'reset' : write.mode,
                        publication: { writer: this.writer, sequence: write.sequence },
                        origin: write.origin,
                    });
                } catch (error) {
                    this.warn(error);
                    this.scheduleFlush();
                    return;
                }
                // Only this serialized drain may acknowledge the head, after success.
                this.resetPending = false;
                this.backlog.release(write.bytes);
                this.writes.shift();
            }
        });
        return this.flushPromise;
    }

    async close(): Promise<void> {
        if (this.finished) {
            if (this.backlog.overflow) throw this.backlog.overflow;
            return;
        }
        if (this.closePromise) return this.closePromise;
        this.closePromise = this.finishClose();
        try { await this.closePromise; }
        finally { this.closePromise = null; }
    }

    private async finishClose(): Promise<void> {
        for (const partial of this.partials.values()) if (partial.text) this.queue(`${partial.text}\n`);
        this.partials.clear();
        this.closed = true;
        await this.flush();
        for (const backoff of [50, 150]) {
            if (this.writes.length === 0) break;
            await delay(backoff);
            await this.flush();
        }
        // Retain failed work for a later close/flush, without leaking an owned connection.
        if (this.writes.length > 0) {
            if (this.ownsRedis) this.redis.disconnect();
            throw new Error('Live output still has unpublished writes');
        }
        if (this.ownsRedis) await this.redis.quit().catch(() => undefined);
        this.finished = true;
        // Everything accepted was published, but the output refused after the overflow was not.
        if (this.backlog.overflow) throw this.backlog.overflow;
    }

    private enqueuePending(): void {
        if (!this.pending) return;
        this.writes.push({ chunk: this.pending, bytes: this.pendingBytes, mode: 'append', sequence: ++this.sequence });
        this.pending = '';
        this.pendingBytes = 0;
    }

    private queue(records: string): void {
        const text = this.options.transformRecord
            ? records.split('\n').map((record, index, all) => (index === all.length - 1 ? record : this.transform(record))).join('\n')
            : records;
        const bytes = Buffer.byteLength(text);
        if (!this.backlog.reserve(bytes)) return;
        this.pending += text;
        this.pendingBytes += bytes;
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (!this.closed && !this.flushTimer) {
            this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, this.options.flushIntervalMs ?? 500);
            this.flushTimer.unref?.();
        }
    }

    private transform(value: string): string {
        return this.options.transformRecord ? this.options.transformRecord(value) : value;
    }

    private warn(error: unknown): void {
        logger.debug({ error: (error as Error).message, taskId: this.taskId }, 'Failed to stream live output to Redis');
    }
}
