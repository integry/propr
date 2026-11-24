/**
 * The API and worker side of idle shutdown (issue #3770). Each process
 * registers as a participant (see idleParticipants.ts) and follows the
 * daemon's drain request (see idleShutdownIntent.ts):
 *
 *   - `quiesce` (API only): stop admitting requests, let the ones in flight
 *     finish, publish the activity record and acknowledge — only once that
 *     callback succeeded; a failure is retried on the next poll. When the request
 *     is withdrawn (the daemon found work) the API admits requests again.
 *   - `stop`: when the request names this process's generation, acknowledge,
 *     then run the process's own graceful shutdown (the default sends SIGTERM
 *     to the process, so the existing path runs; in a composed process see
 *     {@link setIdleShutdownComposedProcess}) and exit 0. The process stays
 *     registered until that shutdown calls `stop`. A stop request for other
 *     generations (one left by a daemon that died mid-drain, read by a
 *     process that started since) is ignored.
 *
 * The request arrives over pub/sub and is also read from Redis on every poll
 * and on every (re)connection, so a process that was disconnected when the
 * daemon announced it still finds it.
 */

import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { IDLE_SHUTDOWN_CHANNEL, IDLE_SHUTDOWN_INTENT_REDIS_KEY } from '@propr/shared';
import { registerIdleParticipant, type IdleParticipantRole } from './idleParticipants.js';
import {
    acknowledgeIdleShutdownIntent,
    isIdleShutdownTarget,
    parseIdleShutdownIntent,
    type IdleShutdownIntent,
    type IntentRedis,
} from './idleShutdownIntent.js';

/** Message on the channel: an intent, or `{ id, phase: 'resume' }` when the daemon withdraws one. */
export function parseIdleShutdownMessage(raw: string): IdleShutdownIntent | { id: string; phase: 'resume' } | null {
    try {
        const value = JSON.parse(raw) as { id?: unknown; phase?: unknown };
        if (value && value.phase === 'resume' && typeof value.id === 'string') return { id: value.id, phase: 'resume' };
    } catch {
        return null;
    }
    return parseIdleShutdownIntent(raw);
}

/** How often the stored request is read, besides pub/sub. */
export const IDLE_INTENT_POLL_MS = 5_000;
/** A quiesced API resumes on its own when it cannot confirm the request for this long. */
export const IDLE_QUIESCE_MAX_UNCONFIRMED_MS = 2 * 60_000;

interface SubscriberRedis {
    on(event: 'message', listener: (channel: string, message: string) => void): unknown;
    on(event: 'ready', listener: () => void): unknown;
    subscribe(channel: string): Promise<unknown>;
    quit(): Promise<unknown>;
}

export interface IdleShutdownListenerOptions {
    role: IdleParticipantRole;
    /** Defaults to `<hostname>:<pid>`. */
    id?: string;
    /** Opens a connection (called twice: commands and subscriber); the listener owns and closes both. */
    createConnection?: () => IntentRedis & SubscriberRedis;
    /** API: stop admitting requests and wait for the ones in flight; resolves when quiesced. */
    onQuiesce?: (intent: IdleShutdownIntent) => Promise<void>;
    /** API: admit requests again. */
    onResume?: () => void;
    /** Run the graceful shutdown; defaults to SIGTERM to this process. */
    onShutdown?: (intent: IdleShutdownIntent) => void;
    pollMs?: number;
    log?: { info(obj: object, msg: string): void; warn?(obj: object, msg: string): void };
}

export interface IdleShutdownListener {
    participantKey: string;
    /** Deregister (this process is stopped) and close the connections. */
    stop: () => Promise<void>;
}

let composedProcess = false;

/**
 * Mark this process as composed (all-in-one): every participant runs in it,
 * and the daemon in the same process runs one coordinated close once each has
 * acknowledged the stop. Participants then only acknowledge, instead of each
 * signalling the shared process.
 */
export function setIdleShutdownComposedProcess(composed: boolean): void {
    composedProcess = composed;
}

export function isIdleShutdownComposedProcess(): boolean {
    return composedProcess;
}

function defaultConnection(): IntentRedis & SubscriberRedis {
    return new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        maxRetriesPerRequest: null,
        retryStrategy: (times: number) => Math.min(times * 50, 2000),
    }) as unknown as IntentRedis & SubscriberRedis;
}

export function startIdleShutdownListener(options: IdleShutdownListenerOptions): IdleShutdownListener {
    const connect = options.createConnection ?? defaultConnection;
    const commands = connect();
    const subscriber = connect();
    const registration = registerIdleParticipant(commands, { role: options.role, id: options.id ?? `${hostname()}:${process.pid}` });
    const onShutdown = options.onShutdown ?? (() => {
        // Composed: the daemon in this process closes every component together.
        if (!composedProcess) process.kill(process.pid, 'SIGTERM');
    });
    let quiesced: { id: string; confirmedAt: number } | null = null;
    let quiesceAcked: string | null = null;
    /** The intent whose `onQuiesce` completed; entering quiescence is not enough to acknowledge. */
    let quiesceReady: string | null = null;
    let stopping = false;
    let ignoredStop: string | null = null;
    let closed = false;
    let chain = Promise.resolve();

    const resume = (reason: string) => {
        if (!quiesced) return;
        options.log?.info({ intentId: quiesced.id, reason }, 'Idle shutdown drain withdrawn; admitting requests again');
        quiesced = null;
        quiesceAcked = null;
        quiesceReady = null;
        options.onResume?.();
    };

    const handleQuiesce = async (intent: IdleShutdownIntent): Promise<void> => {
        if (!options.onQuiesce) return;
        if (!quiesced) {
            quiesced = { id: intent.id, confirmedAt: Date.now() };
            options.log?.info({ intentId: intent.id }, 'Idle shutdown: quiescing (no new requests while the daemon re-checks)');
        }
        quiesced.confirmedAt = Date.now();
        if (quiesceReady !== intent.id) {
            // A failed callback (e.g. the activity record could not be published) stays
            // unacknowledged and is retried on the next poll; the daemon times out and aborts
            // rather than re-checking against older evidence.
            await options.onQuiesce(intent);
            quiesceReady = intent.id;
        }
        if (quiesceAcked !== intent.id) {
            await acknowledgeIdleShutdownIntent(commands, intent, registration.key);
            quiesceAcked = intent.id;
        }
    };

    const handleStop = async (intent: IdleShutdownIntent): Promise<void> => {
        stopping = true;
        options.log?.info({ intentId: intent.id, reason: intent.reason }, 'Idle shutdown requested by the daemon; shutting down gracefully');
        // The daemon waits for this acknowledgement (or for the entry to disappear on a clean stop).
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                await acknowledgeIdleShutdownIntent(commands, intent, registration.key);
                break;
            } catch (error) {
                options.log?.warn?.({ error: (error as Error).message }, 'Idle shutdown: could not acknowledge the drain request');
            }
        }
        onShutdown(intent);
    };

    const handle = async (intent: IdleShutdownIntent | null, readFailed = false): Promise<void> => {
        if (closed || stopping) return;
        if (!intent) {
            if (!quiesced) return;
            // Unreadable is not "withdrawn"; resume only after a long unconfirmed spell.
            if (!readFailed || Date.now() - quiesced.confirmedAt > IDLE_QUIESCE_MAX_UNCONFIRMED_MS) resume(readFailed ? 'unconfirmed' : 'withdrawn');
            return;
        }
        if (!isIdleShutdownTarget(intent, registration.key, registration.participant.startedAt)) {
            if (ignoredStop !== intent.id) {
                ignoredStop = intent.id;
                options.log?.info({ intentId: intent.id, issuedAt: intent.issuedAt }, 'Idle shutdown: ignoring a stop request issued for processes that ran before this one started');
            }
            return;
        }
        if (quiesced && quiesced.id !== intent.id) resume('superseded');
        await (intent.phase === 'quiesce' ? handleQuiesce(intent) : handleStop(intent));
    };

    const enqueue = (work: () => Promise<void>) => {
        chain = chain.then(work).catch((error: unknown) => {
            options.log?.warn?.({ error: (error as Error).message }, 'Idle shutdown: could not act on the drain request');
        });
        return chain;
    };

    const poll = () => enqueue(async () => {
        let raw: string | null;
        try {
            raw = await commands.get(IDLE_SHUTDOWN_INTENT_REDIS_KEY);
        } catch {
            return handle(null, true);
        }
        return handle(parseIdleShutdownIntent(raw));
    });

    subscriber.on('message', (channel: string, raw: string) => {
        if (channel !== IDLE_SHUTDOWN_CHANNEL) return;
        const message = parseIdleShutdownMessage(raw);
        if (!message) return;
        void enqueue(() => (message.phase === 'resume'
            ? (quiesced?.id === message.id ? Promise.resolve(resume('withdrawn')) : Promise.resolve())
            : handle(message)));
    });
    // On every (re)connection: subscribe again is ioredis' job; read what was missed.
    subscriber.on('ready', () => { void poll(); });
    void Promise.resolve().then(() => subscriber.subscribe(IDLE_SHUTDOWN_CHANNEL)).catch((error: Error) => {
        options.log?.warn?.({ error: error.message }, 'Idle shutdown: could not subscribe; relying on polling');
    });
    void poll();
    const timer = setInterval(() => { void poll(); }, options.pollMs ?? IDLE_INTENT_POLL_MS);
    timer.unref?.();

    return {
        participantKey: registration.key,
        stop: async () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            await chain;
            await registration.stop();
            await Promise.all([subscriber.quit().catch(() => undefined), commands.quit().catch(() => undefined)]);
        },
    };
}
