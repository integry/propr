/**
 * Connect frames for opt-in idle shutdown (issue #3770, paired with
 * integry/propr-routing#335).
 *
 *   - `wake_hint`: `{ type: 'wake_hint', reason: 'idle_shutdown', nextDueAt }`
 *     — sent before an idle exit. `nextDueAt` is ISO-8601, or null when only
 *     a delivery should wake the instance.
 *   - `replay`: `{ type: 'replay', reason: 'idle_wake', since }` — sent after
 *     the first connection following an idle wake, asking for the deliveries
 *     cached while the instance was stopped.
 *
 * Sending a frame proves nothing about the relay. Each one must be accepted
 * with a matching frame on the same socket within {@link IDLE_FRAME_ACK_TIMEOUT_MS}:
 *
 *   - `wake_hint_ack`: the relay will wake the instance at `nextDueAt` (or on
 *     a delivery) and replay its cached deliveries on `replay`;
 *   - `replay_ack`: the relay has accepted the replay request.
 *
 * A relay without this support (today's relay answers unknown frames with an
 * `error` frame) never acknowledges, so the daemon does not stop, and a wake
 * keeps its replay pending instead of assuming it happened.
 */

import type { MinimalWebSocket } from './routingWebSocketProtocol.js';

export const WAKE_HINT_FRAME_TYPE = 'wake_hint';
export const REPLAY_FRAME_TYPE = 'replay';
export const WAKE_HINT_ACK_FRAME_TYPE = 'wake_hint_ack';
export const REPLAY_ACK_FRAME_TYPE = 'replay_ack';
export const IDLE_FRAME_ACK_TIMEOUT_MS = 10_000;

export function buildWakeHintFrame(nextDueAt: string | null): Record<string, unknown> {
    return { type: WAKE_HINT_FRAME_TYPE, reason: 'idle_shutdown', nextDueAt };
}

export function buildReplayFrame(since: string | null): Record<string, unknown> {
    return { type: REPLAY_FRAME_TYPE, reason: 'idle_wake', since };
}

/** Whether the relay on the current connection accepted a wake hint. */
export type IdleWakeSupport = 'unknown' | 'accepted' | 'rejected';

type AckOutcome = 'accepted' | 'unanswered' | 'dropped';

interface AckWaiter {
    type: string;
    socket: MinimalWebSocket;
    resolve: (outcome: AckOutcome) => void;
}

interface PendingReplay {
    since: string | null;
    promise: Promise<boolean>;
    resolve: (accepted: boolean) => void;
    /** The socket the request is outstanding on, if any. */
    socket: MinimalWebSocket | null;
}

/** The idle wake/replay exchange on the routing socket; the intake service forwards socket events here. */
export class RoutingIdleWake {
    private readonly waiters = new Set<AckWaiter>();
    private support: IdleWakeSupport = 'unknown';
    private replay: PendingReplay | null = null;

    constructor(
        private readonly send: (frame: Record<string, unknown>, socket: MinimalWebSocket) => boolean,
        private readonly ackTimeoutMs: number = IDLE_FRAME_ACK_TIMEOUT_MS,
    ) {}

    get wakeSupport(): IdleWakeSupport {
        return this.support;
    }

    /** A new connection: support is unknown again (the relay may have changed); send a pending replay. */
    opened(socket: MinimalWebSocket): void {
        this.support = 'unknown';
        void this.sendReplay(socket);
    }

    /** The socket closed: whatever waited on it was not accepted. */
    closed(socket: MinimalWebSocket): void {
        for (const waiter of [...this.waiters]) if (waiter.socket === socket) this.settle(waiter, 'dropped');
    }

    stopped(): void {
        for (const waiter of [...this.waiters]) this.settle(waiter, 'unanswered');
        const replay = this.replay;
        this.replay = null;
        replay?.resolve(false);
    }

    /** Consume an acknowledgement frame; returns false for anything else. */
    handle(frame: { type?: string }, socket: MinimalWebSocket): boolean {
        if (frame.type !== WAKE_HINT_ACK_FRAME_TYPE && frame.type !== REPLAY_ACK_FRAME_TYPE) return false;
        for (const waiter of [...this.waiters]) if (waiter.type === frame.type && waiter.socket === socket) this.settle(waiter, 'accepted');
        return true;
    }

    /** Resolves true only when the relay acknowledged the hint on this socket. */
    async sendWakeHint(socket: MinimalWebSocket | null, nextDueAt: string | null): Promise<boolean> {
        if (!socket) return false;
        const accepted = (await this.exchange(socket, WAKE_HINT_ACK_FRAME_TYPE, buildWakeHintFrame(nextDueAt))) === 'accepted';
        this.support = accepted ? 'accepted' : 'rejected';
        return accepted;
    }

    /**
     * Ask for the replay now (when connected) or on the next connection.
     * Resolves true once the relay accepts it, false when it does not answer
     * on an open socket or the service stops. A socket that drops before an
     * answer retries on the next connection.
     */
    requestReplay(socket: MinimalWebSocket | null, since: string | null): Promise<boolean> {
        if (this.replay) return this.replay.promise;
        let resolve!: (accepted: boolean) => void;
        const promise = new Promise<boolean>(done => { resolve = done; });
        this.replay = { since, promise, resolve, socket: null };
        if (socket) void this.sendReplay(socket);
        return promise;
    }

    private async sendReplay(socket: MinimalWebSocket): Promise<void> {
        const pending = this.replay;
        if (!pending || pending.socket === socket) return;
        pending.socket = socket;
        const outcome = await this.exchange(socket, REPLAY_ACK_FRAME_TYPE, buildReplayFrame(pending.since));
        if (pending.socket === socket) pending.socket = null;
        // A dropped socket is not an answer: ask again on the next connection.
        if (this.replay !== pending || outcome === 'dropped') return;
        this.replay = null;
        pending.resolve(outcome === 'accepted');
    }

    private exchange(socket: MinimalWebSocket, ackType: string, frame: Record<string, unknown>): Promise<AckOutcome> {
        return new Promise<AckOutcome>(resolve => {
            const timer = setTimeout(() => this.settle(waiter, 'unanswered'), this.ackTimeoutMs);
            const waiter: AckWaiter = {
                type: ackType,
                socket,
                resolve: outcome => { clearTimeout(timer); resolve(outcome); },
            };
            this.waiters.add(waiter);
            if (!this.send(frame, socket)) this.settle(waiter, 'dropped');
        });
    }

    private settle(waiter: AckWaiter, outcome: AckOutcome): void {
        if (!this.waiters.delete(waiter)) return;
        waiter.resolve(outcome);
    }
}
