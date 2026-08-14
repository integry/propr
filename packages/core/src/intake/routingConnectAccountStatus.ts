import logger from '../utils/logger.js';
import type { MinimalWebSocket, RoutingFrame } from './routingWebSocketProtocol.js';

/** Additive Connect capability for installation entitlement and seat status. */
export const ACCOUNT_STATUS_CAPABILITY = 'account_status';

/** Account-status frames are deliberately tiny; reject padded/oversized frames. */
export const MAX_ACCOUNT_STATUS_FRAME_BYTES = 16 * 1024;

const MAX_ACCOUNT_LOGIN_LENGTH = 128;
const ISO_TIMESTAMP_PATTERN =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** UI-safe projection of Connect's authenticated installation account status. */
export interface ConnectAccountStatus {
    installationId: number;
    accountLogin: string | null;
    plan: 'community' | 'plus';
    hasPlusAccess: boolean;
    activeSeats: number;
    allowedSeats: number;
    seatsRemaining: number;
    billingCycleResetAt: string;
    seatLimitBlockedAt?: string | null;
    sentAt: string;
}

function isTimestamp(value: unknown): value is string {
    return typeof value === 'string'
        && ISO_TIMESTAMP_PATTERN.test(value)
        && !Number.isNaN(Date.parse(value));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasValidIdentity(frame: RoutingFrame): boolean {
    return Number.isSafeInteger(frame.installationId)
        && (frame.installationId as number) > 0
        && (frame.accountLogin === null
            || (typeof frame.accountLogin === 'string'
                && frame.accountLogin.length > 0
                && frame.accountLogin.length <= MAX_ACCOUNT_LOGIN_LENGTH));
}

function hasValidPlan(frame: RoutingFrame): boolean {
    return (frame.plan === 'community' || frame.plan === 'plus')
        && typeof frame.hasPlusAccess === 'boolean';
}

function hasValidSeatCounts(frame: RoutingFrame): boolean {
    return isNonNegativeSafeInteger(frame.activeSeats)
        && isNonNegativeSafeInteger(frame.allowedSeats)
        && isNonNegativeSafeInteger(frame.seatsRemaining);
}

function hasValidTimestamps(frame: RoutingFrame): boolean {
    return isTimestamp(frame.billingCycleResetAt)
        && (frame.seatLimitBlockedAt === undefined
            || frame.seatLimitBlockedAt === null
            || isTimestamp(frame.seatLimitBlockedAt))
        && isTimestamp(frame.sentAt);
}

/**
 * Strictly validate and copy the additive Connect account-status frame. Returning
 * a new object is intentional: unknown server fields never enter Redis or the UI.
 */
export function parseConnectAccountStatus(frame: RoutingFrame): ConnectAccountStatus | undefined {
    if (frame.type !== 'account_status'
        || !hasValidIdentity(frame)
        || !hasValidPlan(frame)
        || !hasValidSeatCounts(frame)
        || !hasValidTimestamps(frame)) return undefined;

    // These values are defined as derived pairs by the authoritative contract.
    // Reject contradictory frames instead of guessing which field the UI should trust.
    if ((frame.plan === 'plus') !== frame.hasPlusAccess) return undefined;
    if (frame.seatsRemaining !== Math.max(0, frame.allowedSeats! - frame.activeSeats!)) return undefined;

    return {
        installationId: frame.installationId as number,
        accountLogin: frame.accountLogin as string | null,
        plan: frame.plan as 'community' | 'plus',
        hasPlusAccess: frame.hasPlusAccess as boolean,
        activeSeats: frame.activeSeats as number,
        allowedSeats: frame.allowedSeats as number,
        seatsRemaining: frame.seatsRemaining as number,
        billingCycleResetAt: frame.billingCycleResetAt as string,
        ...(frame.seatLimitBlockedAt !== undefined
            ? { seatLimitBlockedAt: frame.seatLimitBlockedAt }
            : {}),
        sentAt: frame.sentAt as string,
    };
}

/** Decode a frame before dispatch so primitives cannot reach the type switch. */
export function parseRoutingFrame(rawFrame: string): RoutingFrame | undefined {
    let frame: unknown;
    try {
        frame = JSON.parse(rawFrame);
    } catch (error) {
        logger.warn(
            { error: (error as Error).message },
            'Discarding malformed routing frame (not valid JSON)',
        );
        return undefined;
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
        logger.warn('Discarding malformed routing frame (expected an object)');
        return undefined;
    }
    return frame as RoutingFrame;
}

/** Owns the connection-scoped account-status state and its rejection policy. */
export class ConnectAccountStatusTracker {
    private readonly installationId: number | undefined;
    private readonly onChange: () => void;
    private account: ConnectAccountStatus | undefined;
    private negotiatedSocket: MinimalWebSocket | null = null;

    constructor(installationId: number | string | undefined, onChange: () => void) {
        const parsedInstallationId = Number(installationId);
        this.installationId = Number.isSafeInteger(parsedInstallationId) && parsedInstallationId > 0
            ? parsedInstallationId
            : undefined;
        this.onChange = onChange;
    }

    get current(): ConnectAccountStatus | undefined {
        return this.account;
    }

    open(
        socket: MinimalWebSocket,
        protocolVersion: number,
        send: (frame: Record<string, unknown>) => boolean,
    ): void {
        this.clear();
        if (send({
            type: 'hello',
            protocolVersion,
            capabilities: [ACCOUNT_STATUS_CAPABILITY],
        })) this.negotiatedSocket = socket;
    }

    clear(): void {
        const changed = this.account !== undefined || this.negotiatedSocket !== null;
        this.account = undefined;
        this.negotiatedSocket = null;
        if (changed) this.onChange();
    }

    handle(
        frame: RoutingFrame,
        socket: MinimalWebSocket,
        frameBytes: number,
    ): void {
        if (socket !== this.negotiatedSocket) {
            logger.warn('Discarding unsolicited or stale-connection account-status frame');
            return;
        }
        if (frameBytes > MAX_ACCOUNT_STATUS_FRAME_BYTES) {
            logger.warn({ frameBytes }, 'Discarding oversized account-status frame');
            return;
        }

        const account = parseConnectAccountStatus(frame);
        if (!account) {
            logger.warn('Discarding malformed account-status frame');
            return;
        }
        if (this.installationId === undefined || account.installationId !== this.installationId) {
            logger.warn(
                { expectedInstallationId: this.installationId, frameInstallationId: account.installationId },
                'Discarding installation-mismatched account-status frame',
            );
            return;
        }
        if (this.account && Date.parse(account.sentAt) <= Date.parse(this.account.sentAt)) {
            logger.warn({ sentAt: account.sentAt }, 'Discarding stale account-status frame');
            return;
        }

        this.account = account;
        this.onChange();
    }
}
