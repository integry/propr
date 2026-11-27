/**
 * The wizard's one device sign-in at a time (deviceFlow.ts), for relay
 * enrollment on the ProPR App path. State is in memory only: the wizard has
 * a single claimant, and a restart simply starts a new code.
 *
 *   start() → a device code; the claimant's browser shows the user code.
 *   poll()  → asks GitHub at most once per interval (the page refreshes on
 *             that interval, so it works without JavaScript), and hands the
 *             user token over exactly once.
 *   hold()  → keeps the token for one more request when the relay offers
 *             several installations and the claimant has to pick one. It is
 *             dropped after that request, or after HELD_TOKEN_TTL_MS.
 *
 * `device_flow_disabled` is remembered for DISABLED_RECHECK_MS so the GitHub
 * step offers the pasted-token form straight away instead of a button that
 * fails; after that the next start asks GitHub again.
 */
import { DeviceFlowDisabledError, DeviceFlowUnreachableError, pollDeviceToken, requestDeviceCode } from './deviceFlow.js';
import { GithubSetupError } from './githubSetup.js';

export const DISABLED_RECHECK_MS = 5 * 60_000;
export const HELD_TOKEN_TTL_MS = 10 * 60_000;

export interface DeviceWaiting {
    kind: 'waiting';
    userCode: string;
    verificationUri: string;
    /** Seconds until the next check, for the page refresh. */
    interval: number;
}

export type DeviceProgress = { kind: 'none' } | DeviceWaiting | { kind: 'token'; token: string };

export interface DeviceEnrollment {
    /** False when GitHub said the App does not enable device flow (recently), or no client ID is configured. */
    available(): boolean;
    start(): Promise<void>;
    poll(): Promise<DeviceProgress>;
    cancel(): void;
    hold(token: string): void;
    takeHeld(): string | undefined;
}

export interface DeviceEnrollmentOptions {
    /** The App's client ID; without one the device flow is never offered. */
    clientId?: string;
    fetcher?: typeof fetch;
    now?: () => number;
}

interface Flow {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    interval: number;
    expiresAt: number;
    nextPollAt: number;
}

export function createDeviceEnrollment(options: DeviceEnrollmentOptions): DeviceEnrollment {
    const { clientId } = options;
    const fetcher = options.fetcher ?? fetch;
    const now = options.now ?? Date.now;
    let flow: Flow | undefined;
    let polling: Promise<DeviceProgress> | undefined;
    let disabledUntil = 0;
    let held: { token: string; expiresAt: number } | undefined;

    const available = (): boolean => Boolean(clientId) && now() >= disabledUntil;
    const waiting = (current: Flow): DeviceWaiting => ({
        kind: 'waiting', userCode: current.userCode, verificationUri: current.verificationUri,
        interval: Math.max(1, Math.ceil((current.nextPollAt - now()) / 1000)),
    });
    const failed = (error: unknown): never => {
        flow = undefined;
        if (error instanceof DeviceFlowDisabledError) disabledUntil = now() + DISABLED_RECHECK_MS;
        throw error;
    };

    async function pollOnce(current: Flow): Promise<DeviceProgress> {
        let result;
        try {
            result = await pollDeviceToken(clientId!, current.deviceCode, current.interval, fetcher);
        } catch (error) {
            // A network failure keeps the code: the next refresh tries again.
            if (error instanceof DeviceFlowUnreachableError) {
                current.nextPollAt = now() + current.interval * 1000;
                return waiting(current);
            }
            return failed(error);
        }
        if (flow !== current) return { kind: 'none' };
        if (result.kind === 'token') {
            flow = undefined;
            return { kind: 'token', token: result.token };
        }
        if (result.kind === 'slow_down') current.interval = result.interval;
        current.nextPollAt = now() + current.interval * 1000;
        return waiting(current);
    }

    return {
        available,
        async start() {
            if (!available()) throw new DeviceFlowDisabledError();
            held = undefined;
            let code;
            try {
                code = await requestDeviceCode(clientId!, fetcher);
            } catch (error) {
                return failed(error);
            }
            const at = now();
            flow = { ...code, expiresAt: at + code.expiresIn * 1000, nextPollAt: at + code.interval * 1000 };
        },
        async poll() {
            const current = flow;
            if (!current) return { kind: 'none' };
            if (now() >= current.expiresAt) return failed(new GithubSetupError('The GitHub code expired before it was entered. Start again for a new code.'));
            // Two tabs, or a refresh while a check is running: one request to GitHub at a time.
            if (polling) return waiting(current);
            if (now() < current.nextPollAt) return waiting(current);
            polling = pollOnce(current);
            try { return await polling; } finally { polling = undefined; }
        },
        cancel() {
            flow = undefined;
            held = undefined;
        },
        hold(token) {
            held = { token, expiresAt: now() + HELD_TOKEN_TTL_MS };
        },
        takeHeld() {
            const entry = held;
            held = undefined;
            return entry && now() < entry.expiresAt ? entry.token : undefined;
        },
    };
}
