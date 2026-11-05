/**
 * Client side of the relay's `delivery_interest.v1` contract
 * (integry/propr-routing#294). The client declares which webhook deliveries it
 * can act on so the relay drops the rest before storing or forwarding them.
 *
 * The declaration may only exclude what the client already discards on every
 * code path, so each rule is built from the same gates the handlers use
 * (webhook/webhookEventGates.ts) and the repository list mirrors the webhook
 * handler's repository filter. Relays that do not know the capability ignore
 * the extra hello field and frame, so older relays keep forwarding everything.
 */
import { SUPPORTED_WEBHOOK_EVENTS } from '@propr/shared';
import logger from '../utils/logger.js';
import { ACCOUNT_STATUS_CAPABILITY } from './routingConnectAccountStatus.js';
import type { MinimalWebSocket } from './routingWebSocketProtocol.js';
import {
    CHECK_RUN_ACTED_ACTIONS,
    CHECK_SUITE_ACTED_ACTIONS,
    CHECK_SUITE_PASSING_CONCLUSIONS,
    PUSH_BRANCH_REF_PREFIX,
    STATUS_ACTED_STATES,
} from '../webhook/webhookEventGates.js';

export const DELIVERY_INTEREST_CAPABILITY = 'delivery_interest.v1';
/** Above this many monitored repositories the declaration falls back to `"*"`. */
export const MAX_INTEREST_REPOSITORIES = 1000;
/** Neither the hello nor the interest frame may exceed this once serialized. */
export const MAX_INTEREST_FRAME_BYTES = 48 * 1024;
/** At most one declaration per window; the relay asks for no more than one per 5 s. */
export const DEFAULT_INTEREST_DEBOUNCE_MS = 5_000;

export interface DeliveryInterestEventRule {
    actions?: string[];
    states?: string[];
    conclusions?: string[];
    refPrefixes?: string[];
    excludeDeleted?: boolean;
}

export interface DeliveryInterest {
    version: 1;
    /** Lowercase `owner/name`; `"*"` disables repository filtering. */
    repositories: '*' | string[];
    /** Events not listed are not wanted. */
    events: Record<string, DeliveryInterestEventRule>;
}

export interface DeliveryInterestInputs {
    /** Repositories the webhook handler's filter accepts, or `"*"` when it accepts any. */
    repositories: '*' | readonly string[];
    /** An injected check-run processor receives every check_run action. */
    checkRunProcessorRegistered: boolean;
}

export type DeliveryInterestProvider = () => DeliveryInterest;

export interface DeliveryInterestServiceOptions {
    /**
     * Source of the `delivery_interest.v1` declaration. Defaults to the shared
     * webhook handler's declaration when `dispatch` is the default handler; with
     * a custom `dispatch` (or `null`) no interest is declared and the relay keeps
     * forwarding every delivery.
     */
    deliveryInterest?: DeliveryInterestProvider | null;
    /** Minimum spacing between declarations, in ms. */
    deliveryInterestDebounceMs?: number;
}

type SupportedEvent = (typeof SUPPORTED_WEBHOOK_EVENTS)[number];

/**
 * One rule per supported event (the Record type makes a newly supported event a
 * compile error until it is declared). Unsupported events are ACKed as ignored
 * before dispatch (isSupportedEventType), so leaving them out drops nothing.
 * Issue, comment and pull_request events stay unfiltered: intent withdrawal,
 * Ultrafix label removal, plan tracking, merged-PR handling and notifications
 * read many of their actions.
 */
function eventRules(checkRunProcessorRegistered: boolean): Record<SupportedEvent, DeliveryInterestEventRule> {
    return {
        issues: {},
        issue_comment: {},
        pull_request_review_comment: {},
        pull_request: {},
        check_run: checkRunProcessorRegistered ? {} : { actions: [...CHECK_RUN_ACTED_ACTIONS] },
        check_suite: { actions: [...CHECK_SUITE_ACTED_ACTIONS], conclusions: [...CHECK_SUITE_PASSING_CONCLUSIONS] },
        push: { refPrefixes: [PUSH_BRANCH_REF_PREFIX], excludeDeleted: true },
        status: { states: [...STATUS_ACTED_STATES] },
    };
}

/** Wants every supported delivery from every repository; used when the inputs are unreadable. */
export const UNFILTERED_DELIVERY_INTEREST: DeliveryInterest = Object.freeze({
    version: 1,
    repositories: '*',
    events: Object.fromEntries(SUPPORTED_WEBHOOK_EVENTS.map(event => [event, {}])),
}) as DeliveryInterest;

export function buildRoutingHello(protocolVersion: number, interest: DeliveryInterest | null): Record<string, unknown> {
    return interest
        ? { type: 'hello', protocolVersion, capabilities: [ACCOUNT_STATUS_CAPABILITY, DELIVERY_INTEREST_CAPABILITY], interest }
        : { type: 'hello', protocolVersion, capabilities: [ACCOUNT_STATUS_CAPABILITY] };
}

export function buildInterestFrame(interest: DeliveryInterest): Record<string, unknown> {
    return { type: 'interest', interest };
}

function largestFrameBytes(interest: DeliveryInterest, protocolVersion: number): number {
    return Math.max(
        Buffer.byteLength(JSON.stringify(buildRoutingHello(protocolVersion, interest)), 'utf8'),
        Buffer.byteLength(JSON.stringify(buildInterestFrame(interest)), 'utf8'),
    );
}

/**
 * Build the declaration. Repositories are lowercased, de-duplicated and sorted
 * so an unchanged set always serializes identically; an oversized set falls back
 * to `"*"` (no repository filtering), which can only forward more.
 */
export function buildDeliveryInterest(inputs: DeliveryInterestInputs, protocolVersion = 1): DeliveryInterest {
    const events = eventRules(inputs.checkRunProcessorRegistered);
    if (inputs.repositories === '*') return { version: 1, repositories: '*', events };
    const repositories = [...new Set(inputs.repositories.map(name => name.trim().toLowerCase()).filter(Boolean))].sort();
    const interest: DeliveryInterest = { version: 1, repositories, events };
    if (repositories.length > MAX_INTEREST_REPOSITORIES
        || largestFrameBytes(interest, protocolVersion) > MAX_INTEREST_FRAME_BYTES) {
        return { version: 1, repositories: '*', events };
    }
    return interest;
}

interface DeliveryInterestAnnouncerOptions {
    provider: DeliveryInterestProvider | null;
    protocolVersion: number;
    debounceMs?: number;
    now: () => number;
    send: (frame: Record<string, unknown>, socket: MinimalWebSocket) => boolean;
}

/**
 * Connection-scoped declaration state: the hello declares the current interest,
 * later changes are sent as `interest` frames at most once per debounce window,
 * and an unchanged declaration is never re-sent.
 */
export class DeliveryInterestAnnouncer {
    private readonly provider: DeliveryInterestProvider | null;
    private readonly protocolVersion: number;
    private readonly debounceMs: number;
    private readonly now: () => number;
    private readonly send: DeliveryInterestAnnouncerOptions['send'];

    private socket: MinimalWebSocket | null = null;
    private declared: DeliveryInterest | null = null;
    private declaredKey: string | null = null;
    private declaredAt = 0;
    private timer: NodeJS.Timeout | null = null;

    constructor(options: DeliveryInterestAnnouncerOptions) {
        this.provider = options.provider;
        this.protocolVersion = options.protocolVersion;
        this.debounceMs = options.debounceMs ?? DEFAULT_INTEREST_DEBOUNCE_MS;
        this.now = options.now;
        this.send = options.send;
    }

    /** The hello for a newly opened socket, declaring the current interest. */
    open(socket: MinimalWebSocket): Record<string, unknown> {
        this.clear();
        if (!this.provider) return buildRoutingHello(this.protocolVersion, null);
        this.socket = socket;
        this.record(this.current());
        return buildRoutingHello(this.protocolVersion, this.declared);
    }

    /**
     * Heartbeat hellos repeat what the socket already declared, so they never
     * reset it. A hello carrying the declaration still counts as one, so it
     * restarts the debounce window before the next `interest` frame.
     */
    probeHello(): Record<string, unknown> {
        if (this.socket && this.declared) this.declaredAt = this.now();
        return buildRoutingHello(this.protocolVersion, this.socket ? this.declared : null);
    }

    /** Re-derive the declaration and send it if it changed (debounced). */
    refresh(): void {
        if (!this.socket || this.timer) return;
        const wait = this.declaredAt + this.debounceMs - this.now();
        if (wait <= 0) {
            this.announce();
            return;
        }
        if (JSON.stringify(this.current()) === this.declaredKey) return;
        // Re-check the window when the timer fires: a heartbeat hello sent in the
        // meantime restarts it.
        this.timer = setTimeout(() => {
            this.timer = null;
            this.refresh();
        }, wait);
    }

    clear(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.socket = null;
        this.declared = null;
        this.declaredKey = null;
        this.declaredAt = 0;
    }

    private announce(): void {
        const socket = this.socket;
        if (!socket) return;
        const interest = this.current();
        if (JSON.stringify(interest) === this.declaredKey) return;
        if (this.send(buildInterestFrame(interest), socket)) {
            this.record(interest);
            logger.info({ repositories: interest.repositories === '*' ? '*' : interest.repositories.length },
                'Declared updated delivery interest to the routing relay');
        }
    }

    private record(interest: DeliveryInterest): void {
        this.declared = interest;
        this.declaredKey = JSON.stringify(interest);
        this.declaredAt = this.now();
    }

    private current(): DeliveryInterest {
        try {
            return this.provider!();
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Failed to derive delivery interest; declaring every delivery wanted');
            return UNFILTERED_DELIVERY_INTEREST;
        }
    }
}
