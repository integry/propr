import type { IdleBlocker } from '@propr/shared';
import { emptyIdleSignals, evaluateIdle, type IdleSignals } from '@propr/core';
import type { IdleDrainContext } from './idleShutdown.js';

/**
 * The idle drain's last checks (issue #3770). Work a stop would strand is read
 * once every process acknowledged the stop. API activity is read right before
 * the stop request is stored (an abort, intake restored) and again then (a
 * call-off, exit 1): a request the quiesced API turns away gets `503` with
 * `Retry-After`, so the client is about to retry, and the instance must be up
 * to serve it.
 */

/** API activity, unreadable counting as activity (an unread request must not be stopped on). */
export function readActivity(ctx: Pick<IdleDrainContext, 'collect' | 'collectActivity'>): Promise<IdleSignals> {
    return (ctx.collectActivity ?? ctx.collect)().catch((error: Error) => ({ ...emptyIdleSignals(), unavailable: [`API activity (${error.message})`] }));
}

/**
 * What the API shows of someone using the instance: open sessions, requests in flight (none while quiesced), any
 * request since the idle period began (one turned away while quiesced included), and activity it could not read.
 */
export function activitySince(signals: IdleSignals, idleSince: number): IdleBlocker[] {
    const { uiSessions, mcpRequests, httpRequests, unavailable } = signals;
    const blockers = evaluateIdle({ ...emptyIdleSignals(), uiSessions, mcpRequests, httpRequests, unavailable }, { now: Date.now(), windowMs: 0 }).blockers;
    const last = signals.lastActivityAt ?? 0;
    if (last > idleSince) blockers.push({ signal: 'http_requests', detail: `a request reached the API at ${new Date(last).toISOString()}, after the idle period began` });
    return blockers;
}

/** What a stop would strand: work queued or running, or scheduled before the wake arranged for it (or with none arranged). */
export function strandedWork(signals: IdleSignals, wakeAt: number | null, now: number): IdleBlocker[] {
    const evaluation = evaluateIdle(signals, { now, windowMs: 0 });
    const next = evaluation.nextDueAt;
    if (next === null || next <= now || (wakeAt !== null && next >= wakeAt)) return evaluation.blockers;
    return [...evaluation.blockers, { signal: 'scheduled_work', detail: `scheduled work due at ${new Date(next).toISOString()}, before the wake arranged for the stop` }];
}
