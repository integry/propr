import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { TASK_STEER_MAX_PER_RUN, TASK_STEER_SECTION_TITLE } from '@propr/shared';
import { redactSecrets } from '../utils/secretRedaction.js';
import type { LiveInputMessage, LiveInputSource } from '../claude/docker/dockerLiveInput.js';

/**
 * Durable operator steering for ordinary task runs (`task_steers`).
 *
 * A steer is claimed by setting `delivered_at` in the same statement that
 * checks it is still pending, before anything is written to the agent, so
 * each steer reaches an agent at most once: live into the running session,
 * or, when the run ended first, in the prompt of the replacement run.
 *
 * A replacement-run claim is first recorded as being prepared
 * (`prompt_preparing`). It becomes `replacement_prompt` before any agent
 * process is started with that prompt, and is acknowledged once the agent's
 * own output shows it received the prompt. A preparation claim abandoned by a
 * worker that died never exposed its prompt, so the next replacement run of
 * the task reclaims it; a `replacement_prompt` claim may have reached an agent
 * and is never reclaimed.
 *
 * A live claim held until a step boundary is likewise stored as being held
 * (`live_held`) and becomes `live` immediately before it is written to the
 * agent: input held by a worker that died reached no agent, so the next
 * replacement run reclaims it, while a `live` claim is never replayed.
 */

export type TaskSteerAuthorSource = 'session' | 'token' | 'mcp';
export type TaskSteerDelivery = 'live' | 'replacement_prompt';

export interface TaskSteer {
    id: string;
    sequence: number;
    taskId: string;
    runKey: string | null;
    author: string;
    authorSource: TaskSteerAuthorSource;
    message: string;
    createdAt: string;
    deliveredAt: string | null;
    delivery: TaskSteerDelivery | null;
    acknowledgedAt: string | null;
}

interface TaskSteerRow {
    sequence: number;
    steer_id: string;
    task_id: string;
    run_key: string | null;
    author: string;
    author_source: string;
    message: string;
    created_at: string | Date;
    delivered_at: string | Date | null;
    delivery: string | null;
    acknowledged_at: string | Date | null;
}

export class TaskSteerLimitError extends Error {
    constructor(readonly limit = TASK_STEER_MAX_PER_RUN) {
        super(`A run accepts at most ${limit} steering messages`);
        this.name = 'TaskSteerLimitError';
    }
}

type Db = Knex | Knex.Transaction;

/** Stored `delivery` of a replacement claim whose prompt has not reached an agent process yet. */
const REPLACEMENT_PREPARING = 'prompt_preparing';
/** Stored `delivery` of a live claim held for a later write that has not been written yet. */
const LIVE_HELD = 'live_held';

function timestamp(value: string | Date | null): string | null {
    if (value === null || value === undefined) return null;
    return value instanceof Date ? value.toISOString() : String(value);
}

function toSteer(row: TaskSteerRow): TaskSteer {
    // A claim still being prepared or held has reached no agent: it is reported as pending.
    const preparing = row.delivery === REPLACEMENT_PREPARING || row.delivery === LIVE_HELD;
    return {
        id: row.steer_id,
        sequence: Number(row.sequence),
        taskId: row.task_id,
        runKey: row.run_key,
        author: row.author,
        authorSource: row.author_source as TaskSteerAuthorSource,
        message: row.message,
        createdAt: timestamp(row.created_at)!,
        deliveredAt: preparing ? null : timestamp(row.delivered_at),
        delivery: preparing ? null : row.delivery as TaskSteerDelivery | null,
        acknowledgedAt: timestamp(row.acknowledged_at),
    };
}

/**
 * Persist a steer for the run identified by `runKey`. Throws
 * {@link TaskSteerLimitError} once the run already accepted the maximum.
 */
export async function createTaskSteer(db: Knex, input: {
    taskId: string;
    runKey: string | null;
    author: string;
    authorSource: TaskSteerAuthorSource;
    message: string;
}): Promise<TaskSteer> {
    return db.transaction(async trx => {
        const runFilter = input.runKey === null
            ? (query: Knex.QueryBuilder) => query.whereNull('run_key')
            : (query: Knex.QueryBuilder) => query.where('run_key', input.runKey);
        const counted = await runFilter(trx('task_steers').where('task_id', input.taskId))
            .count<{ count: number | string }[]>({ count: '*' });
        if (Number(counted[0]?.count ?? 0) >= TASK_STEER_MAX_PER_RUN) throw new TaskSteerLimitError();
        const steerId = randomUUID();
        await trx('task_steers').insert({
            steer_id: steerId,
            task_id: input.taskId,
            run_key: input.runKey,
            author: input.author,
            author_source: input.authorSource,
            message: input.message,
        });
        const row = await trx<TaskSteerRow>('task_steers').where('steer_id', steerId).first();
        return toSteer(row!);
    });
}

/** All steers of a task in submission order. */
export async function listTaskSteers(db: Db, taskId: string): Promise<TaskSteer[]> {
    const rows = await db<TaskSteerRow>('task_steers').where('task_id', taskId).orderBy('sequence', 'asc');
    return rows.map(toSteer);
}

/**
 * Claim every pending steer of a task for one delivery. A steer is returned
 * by exactly one claim: the update only matches rows that are still pending.
 *
 * A `replacement_prompt` claim is stored as being prepared until
 * {@link markTaskSteersHandedOff} records that an agent process received the
 * prompt. It also reclaims preparation and held claims an earlier run
 * abandoned (its worker exited before writing them to any agent), since a
 * replacement run only starts once the task's previous run ended.
 *
 * With `held`, a `live` claim is stored as held until
 * {@link markTaskSteersWritten} records, just before the write, that it may
 * reach the agent.
 */
export async function claimTaskSteers(db: Knex, taskId: string, delivery: TaskSteerDelivery, options: { held?: boolean } = {}): Promise<TaskSteer[]> {
    const claimable = (query: Knex.QueryBuilder): Knex.QueryBuilder => delivery === 'replacement_prompt'
        ? query.where(pending => pending
            .whereNull('delivered_at')
            .orWhere(abandoned => abandoned.whereIn('delivery', [REPLACEMENT_PREPARING, LIVE_HELD]).whereNull('acknowledged_at')))
        : query.whereNull('delivered_at');
    const stored = delivery === 'replacement_prompt' ? REPLACEMENT_PREPARING : options.held ? LIVE_HELD : delivery;
    return db.transaction(async trx => {
        const pending: TaskSteerRow[] = await claimable(trx('task_steers').where('task_id', taskId))
            .orderBy('sequence', 'asc');
        const claimed: TaskSteer[] = [];
        for (const row of pending) {
            const updated = await claimable(trx('task_steers').where('steer_id', row.steer_id))
                .update({ delivered_at: trx.fn.now(), delivery: stored });
            if (updated !== 1) continue;
            const current = await trx<TaskSteerRow>('task_steers').where('steer_id', row.steer_id).first();
            claimed.push(toSteer(current!));
        }
        return claimed;
    });
}

/**
 * Record, before any agent process is started with the prompt carrying these
 * replacement claims, that it may reach an agent: from then on they are never
 * reclaimed. Returns how many claims were still being prepared and moved.
 */
export async function markTaskSteersHandedOff(db: Db, steerIds: string[]): Promise<number> {
    if (!steerIds.length) return 0;
    return db('task_steers')
        .whereIn('steer_id', steerIds)
        .where('delivery', REPLACEMENT_PREPARING)
        .update({ delivered_at: db.fn.now(), delivery: 'replacement_prompt' });
}

/**
 * Record, immediately before held live claims are written to the agent, that
 * they may reach it: from then on they are never reclaimed. Returns the ids
 * still held by this claim, the only ones that may be written.
 */
export async function markTaskSteersWritten(db: Knex, steerIds: string[]): Promise<string[]> {
    if (!steerIds.length) return [];
    return db.transaction(async trx => {
        const moved: string[] = [];
        for (const steerId of steerIds) {
            const updated = await trx('task_steers')
                .where('steer_id', steerId)
                .where('delivery', LIVE_HELD)
                .whereNull('acknowledged_at')
                .update({ delivered_at: trx.fn.now(), delivery: 'live' });
            if (updated === 1) moved.push(steerId);
        }
        return moved;
    });
}

/** Record that the agent's own output showed it received the prompt carrying these claims. */
export async function confirmTaskSteersReceived(db: Db, steerIds: string[]): Promise<void> {
    if (!steerIds.length) return;
    await db('task_steers')
        .whereIn('steer_id', steerIds)
        .where('delivery', 'replacement_prompt')
        .whereNull('acknowledged_at')
        .update({ acknowledged_at: db.fn.now() });
}

export async function acknowledgeTaskSteer(db: Db, steerId: string): Promise<void> {
    await db('task_steers').where('steer_id', steerId).whereNull('acknowledged_at').update({ acknowledged_at: db.fn.now() });
}

/**
 * Return claimed steers that were never written to an agent to the pending
 * queue. Acknowledged steers are never released.
 */
export async function releaseTaskSteers(db: Db, steerIds: string[]): Promise<void> {
    if (!steerIds.length) return;
    await db('task_steers')
        .whereIn('steer_id', steerIds)
        .whereNull('acknowledged_at')
        .update({ delivered_at: null, delivery: null });
}

/** The text a running agent receives for one steer. */
export function formatTaskSteerForAgent(steer: Pick<TaskSteer, 'author' | 'message'>): string {
    return [
        `Operator input from ${steer.author} while you are working on this task:`,
        '',
        steer.message,
        '',
        'Take this into account and continue the task.',
    ].join('\n');
}

/**
 * Prompt context for a replacement run: steers the previous run accepted but
 * never delivered before it ended.
 */
export function formatReplacementRunSteers(steers: Array<Pick<TaskSteer, 'author' | 'message'>>): string {
    if (!steers.length) return '';
    return [
        `## ${TASK_STEER_SECTION_TITLE}`,
        '',
        'An operator sent the following instructions while a previous run of this task was in progress.',
        'That run ended before they could be delivered. Follow them in this run:',
        '',
        ...steers.map((steer, index) => `${index + 1}. From ${steer.author}:\n${quote(steer.message)}`),
    ].join('\n');
}

function quote(text: string): string {
    return text.split('\n').map(line => `> ${line}`).join('\n');
}

/**
 * Budget of the steering section in a completion comment. Accepted steering
 * alone can exceed GitHub's 65,536-character comment limit (20 messages of
 * 4,000 characters per run, and a task can have several runs), so the section
 * is bounded and leaves the rest of the report its room.
 */
export const TASK_STEER_COMMENT_MAX_LENGTH = 12_000;
/** Longest excerpt of one message, so later messages are not crowded out by one long one. */
const TASK_STEER_COMMENT_MESSAGE_MAX_LENGTH = 1_500;

/**
 * Markdown section for a task's completion comment, or '' when nobody steered
 * the run. Messages are redacted, and the section never exceeds `maxLength`:
 * long messages are shortened and messages past the budget are omitted, with
 * a pointer to the task history (`taskUrl`) that keeps the full text.
 */
export function formatTaskSteersForComment(steers: TaskSteer[], options: { taskUrl?: string; maxLength?: number } = {}): string {
    if (!steers.length) return '';
    const maxLength = options.maxLength ?? TASK_STEER_COMMENT_MAX_LENGTH;
    const history = options.taskUrl ? `the [task history](${options.taskUrl})` : 'the task history';
    const heading = `### ${TASK_STEER_SECTION_TITLE}`;
    const entries = steers.map(steer => {
        const state = steer.delivery === 'live'
            ? (steer.acknowledgedAt ? 'delivered live' : 'claimed, not confirmed')
            : steer.delivery === 'replacement_prompt'
                ? (steer.acknowledgedAt ? 'delivered in the replacement run prompt' : 'carried into the replacement run prompt, not confirmed')
                : 'not delivered';
        const message = redactSecrets(steer.message);
        const shortened = message.length > TASK_STEER_COMMENT_MESSAGE_MAX_LENGTH;
        const excerpt = shortened ? `${message.slice(0, TASK_STEER_COMMENT_MESSAGE_MAX_LENGTH)}…` : message;
        return { text: `- **${steer.author}** (${state}):\n${quote(excerpt)}`, shortened };
    });
    const notice = (omitted: number, shortened: boolean): string => {
        if (!omitted && !shortened) return '';
        const parts = [
            ...(omitted ? [`${omitted} more message${omitted === 1 ? ' was' : 's were'} omitted`] : []),
            ...(shortened ? ['long messages were shortened'] : []),
        ];
        return `_${parts.join('; ')} to keep this report within GitHub's size limit. See ${history} for the full operator input._`;
    };
    const render = (count: number): string => {
        const included = entries.slice(0, count);
        const footer = notice(entries.length - count, included.some(entry => entry.shortened));
        return [heading, '', ...included.map(entry => entry.text), ...(footer ? ['', footer] : [])].join('\n');
    };
    const complete = render(entries.length);
    if (complete.length <= maxLength) return complete;
    // Keep the leading messages that fit next to the longest possible notice.
    const reserved = notice(entries.length, true).length + 2;
    let length = heading.length + 1;
    let count = 0;
    while (count < entries.length && length + 1 + entries[count]!.text.length + reserved <= maxLength) {
        length += 1 + entries[count]!.text.length;
        count += 1;
    }
    const section = render(count);
    return section.length <= maxLength ? section : '';
}

/**
 * Add a task timeline (task_history) entry for a delivered steer. It is
 * written while the agent runs, so it carries the run's `processing` state
 * and never changes the task's lifecycle.
 */
export async function recordTaskSteerTimeline(db: Db, steer: Pick<TaskSteer, 'id' | 'taskId' | 'author' | 'authorSource' | 'message'>, delivery: TaskSteerDelivery): Promise<void> {
    const task = await db('tasks').where({ task_id: steer.taskId }).first('task_id');
    if (!task) return;
    const preview = steer.message.length > 200 ? `${steer.message.slice(0, 197)}...` : steer.message;
    await db('task_history').insert({
        task_id: steer.taskId,
        state: 'processing',
        timestamp: new Date().toISOString(),
        reason: delivery === 'live'
            ? `Operator input from ${steer.author} delivered to the running agent: ${preview}`
            : `Operator input from ${steer.author} carried into this run's prompt: ${preview}`,
        metadata: JSON.stringify({
            taskSteer: { id: steer.id, author: steer.author, authorSource: steer.authorSource, delivery, message: steer.message },
        }),
    });
}

/** Live input source that claims and acknowledges one task's steers. */
export function createTaskSteeringSource(db: Knex, taskId: string): LiveInputSource {
    const claimed = new Map<string, TaskSteer>();
    return {
        async claim(): Promise<LiveInputMessage[]> {
            const steers = await claimTaskSteers(db, taskId, 'live');
            for (const steer of steers) claimed.set(steer.id, steer);
            return steers.map(steer => ({ id: steer.id, text: formatTaskSteerForAgent(steer) }));
        },
        async hold(): Promise<LiveInputMessage[]> {
            const steers = await claimTaskSteers(db, taskId, 'live', { held: true });
            for (const steer of steers) claimed.set(steer.id, steer);
            return steers.map(steer => ({ id: steer.id, text: formatTaskSteerForAgent(steer) }));
        },
        async markWritten(steerIds: string[]): Promise<string[]> {
            const moved = await markTaskSteersWritten(db, steerIds);
            // A claim no longer held was reclaimed elsewhere: it is not this run's to record.
            for (const steerId of steerIds) if (!moved.includes(steerId)) claimed.delete(steerId);
            return moved;
        },
        async acknowledge(steerId: string): Promise<void> {
            await acknowledgeTaskSteer(db, steerId);
            const steer = claimed.get(steerId);
            claimed.delete(steerId);
            if (steer) await recordTaskSteerTimeline(db, steer, 'live');
        },
        async release(steerIds: string[]): Promise<void> {
            for (const steerId of steerIds) claimed.delete(steerId);
            await releaseTaskSteers(db, steerIds);
        },
    };
}
