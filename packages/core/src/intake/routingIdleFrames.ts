/**
 * Connect frames for opt-in idle shutdown (issue #3770, paired with
 * integry/propr-routing#335). Both are additive: a relay that does not know
 * them answers with an `error` frame, which the intake service only logs.
 *
 *   - `wake_hint`: `{ type: 'wake_hint', nextDueAt, reason }` — sent just
 *     before an idle exit so Connect can wake the instance when scheduled
 *     work is due (`nextDueAt` is ISO-8601, or null when nothing is
 *     scheduled and only a delivery should wake it).
 *   - `replay`: `{ type: 'replay', reason, since }` — sent once after the
 *     first connection following an idle wake, asking the relay to replay
 *     deliveries it cached while the instance was stopped. Relays that replay
 *     automatically on reconnect deliver them anyway; either way the
 *     delivery-id dedupe drops anything seen twice.
 */

export const WAKE_HINT_FRAME_TYPE = 'wake_hint';
export const REPLAY_FRAME_TYPE = 'replay';

export function buildWakeHintFrame(nextDueAt: string | null): Record<string, unknown> {
    return { type: WAKE_HINT_FRAME_TYPE, reason: 'idle_shutdown', nextDueAt };
}

export function buildReplayFrame(since: string | null): Record<string, unknown> {
    return { type: REPLAY_FRAME_TYPE, reason: 'idle_wake', since };
}
