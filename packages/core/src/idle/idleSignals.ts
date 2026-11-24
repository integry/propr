/**
 * Collectors for the idle detector's signals (issue #3770). Each one reads a
 * shared store (Redis or the database) so the daemon sees work owned by any
 * process: BullMQ queues, agent runs, goals, follow-up handoffs, scheduled
 * automations, and the activity heartbeats the API publishes for open Web UI
 * sessions and in-flight MCP/HTTP requests.
 *
 * A collector that throws is reported as `unavailable`, which keeps the
 * instance awake rather than guessing.
 */

import type { Knex } from 'knex';
import { IDLE_ACTIVITY_REDIS_PREFIX, type ScheduledItem } from '@propr/shared';
import { emptyIdleSignals, type IdleQueueCounts, type IdleSignals } from './idleDetector.js';
import { parseIdleActivity } from './idleActivity.js';
import {
    IDLE_PARTICIPANT_STALE_MS,
    idleParticipantKey,
    isIdleParticipantConfirmedGone,
    listIdleParticipants,
    localProcessIdentity,
    type LocalProcessIdentity,
} from './idleParticipants.js';

/** The slice of ioredis the collectors use. */
export interface IdleRedis {
    scan(cursor: string, matchToken: 'MATCH', pattern: string, countToken: 'COUNT', count: number): Promise<[string, string[]]>;
    llen(key: string): Promise<number>;
    zcard(key: string): Promise<number>;
    zrange(key: string, start: number, stop: number, withScores: 'WITHSCORES'): Promise<string[]>;
    get(key: string): Promise<string | null>;
    hgetall(key: string): Promise<Record<string, string>>;
}

/** BullMQ's default key prefix. */
export const BULLMQ_PREFIX = 'bull';
/** BullMQ stores a delayed job's due time as `dueAt * 0x1000 + counter`. */
const DELAYED_SCORE_FACTOR = 0x1000;
/** Agent run states in which work is queued or executing. Waiting for a person (`awaiting_approval`) is not. */
export const ACTIVE_AGENT_RUN_STATES = ['queued', 'running', 'report_ready', 'acting'] as const;

async function scanKeys(redis: IdleRedis, pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        keys.push(...batch);
        cursor = next;
    } while (cursor !== '0');
    return [...new Set(keys)];
}

/** Names of every BullMQ queue in Redis, found by their `meta` hash. */
export async function discoverQueueNames(redis: IdleRedis, prefix = BULLMQ_PREFIX): Promise<string[]> {
    const keys = await scanKeys(redis, `${prefix}:*:meta`);
    return keys.map(key => key.slice(prefix.length + 1, -':meta'.length)).filter(Boolean).sort();
}

/** Job counts for one queue, plus its earliest delayed job as a scheduled item. */
export async function readQueueCounts(
    redis: IdleRedis,
    name: string,
    prefix = BULLMQ_PREFIX,
): Promise<{ counts: IdleQueueCounts; delayed: ScheduledItem | null }> {
    const key = (suffix: string) => `${prefix}:${name}:${suffix}`;
    const [waiting, active, prioritized, waitingChildren, paused, firstDelayed] = await Promise.all([
        redis.llen(key('wait')),
        redis.llen(key('active')),
        redis.zcard(key('prioritized')),
        redis.zcard(key('waiting-children')),
        redis.llen(key('paused')),
        redis.zrange(key('delayed'), 0, 0, 'WITHSCORES'),
    ]);
    const score = firstDelayed.length >= 2 ? Number(firstDelayed[1]) : Number.NaN;
    const delayed = Number.isFinite(score)
        ? { kind: 'delayed_job' as const, dueAt: Math.floor(score / DELAYED_SCORE_FACTOR), detail: `delayed job in ${name}` }
        : null;
    return { counts: { name, waiting, active, prioritized, waitingChildren, paused }, delayed };
}

export async function collectQueueSignals(redis: IdleRedis, prefix = BULLMQ_PREFIX): Promise<Pick<IdleSignals, 'queues' | 'scheduled'>> {
    const names = await discoverQueueNames(redis, prefix);
    const results = await Promise.all(names.map(name => readQueueCounts(redis, name, prefix)));
    return {
        queues: results.map(result => result.counts),
        scheduled: results.flatMap(result => (result.delayed ? [result.delayed] : [])),
    };
}

/**
 * Sum the activity every API process publishes. Each registered API process
 * must have a current, well-formed record: a missing, stale or malformed one
 * is unavailable evidence (it may hold open sessions or requests), not zero,
 * until the process is confirmed stopped.
 */
export async function collectActivitySignals(
    redis: IdleRedis,
    options: { now?: number; local?: LocalProcessIdentity; isGone?: (pid: number) => boolean } = {},
): Promise<Pick<IdleSignals, 'uiSessions' | 'mcpRequests' | 'httpRequests' | 'lastActivityAt' | 'unavailable'>> {
    const now = options.now ?? Date.now();
    const totals = { uiSessions: 0, mcpRequests: 0, httpRequests: 0, lastActivityAt: null as number | null, unavailable: [] as string[] };
    const local = options.local ?? localProcessIdentity();
    const expected = new Set<string>();
    for (const { participant } of await listIdleParticipants(redis)) {
        if (participant?.role !== 'api' || isIdleParticipantConfirmedGone(participant, local, options.isGone)) continue;
        expected.add(idleParticipantKey(participant.role, participant.id));
    }
    const observed = new Set<string>();
    for (const key of await scanKeys(redis, `${IDLE_ACTIVITY_REDIS_PREFIX}*`)) {
        const activity = parseIdleActivity(await redis.get(key));
        if (!activity || now - activity.publishedAt > IDLE_PARTICIPANT_STALE_MS) continue;
        observed.add(key.slice(IDLE_ACTIVITY_REDIS_PREFIX.length));
        totals.uiSessions += activity.uiSessions;
        totals.mcpRequests += activity.mcpRequests;
        totals.httpRequests += activity.httpRequests;
        if (activity.lastRequestAt > 0) totals.lastActivityAt = Math.max(totals.lastActivityAt ?? 0, activity.lastRequestAt);
    }
    for (const key of expected) {
        if (!observed.has(key)) totals.unavailable.push(`API activity from ${key} (no current record)`);
    }
    return totals;
}

async function countRows(query: Knex.QueryBuilder): Promise<number> {
    const row = await query.count<{ count: number | string }[]>({ count: '*' }).first();
    return Number(row?.count ?? 0);
}

async function minimum(query: Knex.QueryBuilder, column: string): Promise<number | null> {
    const row = await query.min<{ value: number | string | null }[]>({ value: column }).first();
    const value = row?.value;
    return value === null || value === undefined ? null : Number(value);
}

async function hasTable(database: Knex, table: string): Promise<boolean> {
    return database.schema.hasTable(table);
}

/** Agent runs, scheduled automations, goals and follow-up handoffs from the database. */
export async function collectDatabaseSignals(
    database: Knex,
): Promise<Pick<IdleSignals, 'activeAgentRuns' | 'runningGoals' | 'followupHandoffs' | 'scheduled'>> {
    const scheduled: ScheduledItem[] = [];
    let activeAgentRuns = 0;
    if (await hasTable(database, 'agent_runs')) {
        activeAgentRuns = await countRows(database('agent_runs').whereIn('state', ACTIVE_AGENT_RUN_STATES));
        const deferredUntil = await minimum(database('agent_runs').where('state', 'deferred').whereNotNull('deferred_until'), 'deferred_until');
        if (deferredUntil !== null) scheduled.push({ kind: 'deferred_automation_run', dueAt: deferredUntil, detail: 'deferred automation run' });
    }
    if (await hasTable(database, 'agent_definitions')) {
        const enabled = () => database('agent_definitions').where({ schedule_enabled: true, enabled: true });
        const nextRunAt = await minimum(enabled().whereNotNull('next_run_at'), 'next_run_at');
        if (nextRunAt !== null) scheduled.push({ kind: 'automation', dueAt: nextRunAt, detail: 'scheduled automation' });
        // A claimed slot whose run receipt does not exist yet is due right away.
        if (await database.schema.hasColumn('agent_definitions', 'pending_schedule_slot')) {
            const pending = await minimum(enabled().whereNotNull('pending_schedule_slot'), 'pending_schedule_slot');
            if (pending !== null) scheduled.push({ kind: 'automation', dueAt: pending, detail: 'pending automation slot' });
        }
    }
    const runningGoals = await hasTable(database, 'goals')
        ? await countRows(database('goals').where('desired_state', 'running').whereNull('result_state'))
        : 0;
    const followupHandoffs = await hasTable(database, 'pr_followup_handoffs')
        ? await countRows(database('pr_followup_handoffs').where('status', 'active'))
        : 0;
    return { activeAgentRuns, runningGoals, followupHandoffs, scheduled };
}

/** A named signal source; `collectIdleSignals` merges the parts they return. */
export type IdleSignalSource = () => Promise<Partial<IdleSignals>>;

/**
 * Run every source and merge the parts. Scheduled items are concatenated;
 * counts add up; a failed source is listed as unavailable.
 */
export async function collectIdleSignals(sources: Record<string, IdleSignalSource>): Promise<IdleSignals> {
    const signals = emptyIdleSignals();
    const entries = Object.entries(sources);
    const results = await Promise.allSettled(entries.map(([, source]) => source()));
    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            signals.unavailable.push(entries[index][0]);
            return;
        }
        mergeSignals(signals, result.value);
    });
    return signals;
}

const COUNT_FIELDS = ['activeAgentRuns', 'uiSessions', 'mcpRequests', 'httpRequests', 'followupHandoffs',
    'connectDeliveries', 'runningGoals', 'ultrafixLoops'] as const;

function mergeSignals(target: IdleSignals, part: Partial<IdleSignals>): void {
    for (const field of COUNT_FIELDS) target[field] += part[field] ?? 0;
    if (part.queues) target.queues.push(...part.queues);
    if (part.scheduled) target.scheduled.push(...part.scheduled);
    if (part.unavailable) target.unavailable.push(...part.unavailable);
    if (typeof part.lastActivityAt === 'number') target.lastActivityAt = Math.max(target.lastActivityAt ?? 0, part.lastActivityAt);
}
