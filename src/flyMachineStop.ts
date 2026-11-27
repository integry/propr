/**
 * Idle shutdown on a Fly Machine (#3770): stop the whole Machine, not only the
 * app. `propr deploy fly` runs the app and Redis (and optionally cloudflared
 * and a Docker daemon) as containers of ONE Machine. An app exit 0 leaves the
 * other containers running, so the Machine stays `started`: unreachable,
 * still billed, and never woken by the Fly proxy, which only starts a
 * *stopped* Machine. So the idle stop asks the Machines API, through the
 * Machine's private `_api.internal:4280` endpoint, to stop this Machine, with
 * the app-scoped deploy token `propr deploy fly` stores as a Fly secret.
 *
 * A Fly dashboard launch sets PROPR_FLY_EXIT_STOPS_MACHINE=1 instead: one
 * container, so the exit alone stops the Machine.
 *
 * Kept free of service imports so it can be tested without Redis or SQLite.
 */
import { FLY_EXIT_STOPS_MACHINE_ENV } from '@propr/shared';
import type { HostStop } from './allInOneConfig.js';

/** Fly secret with the app-scoped token the Machine stops itself with. */
export const FLY_MACHINE_STOP_TOKEN_ENV = 'PROPR_FLY_MACHINE_STOP_TOKEN';

/** The Machines API as seen from inside a Fly Machine (private network). */
export const FLY_INTERNAL_MACHINES_API_URL = 'http://_api.internal:4280';

export type FlyMachineStop =
    /** Not on a Fly Machine: an exit 0 is the stop (systemd, single-container hosts). */
    | { kind: 'not_fly' }
    | { kind: 'ready'; app: string; machineId: string; stop: HostStop }
    /** On a Fly Machine but unable to stop it: idle shutdown must keep it awake. */
    | { kind: 'unavailable'; problem: string };

/** Macaroon tokens (`fly tokens create deploy`) carry their own `FlyV1 ` scheme; anything else is a Bearer token. */
export function flyMachineStopAuthorization(token: string): string {
    const trimmed = token.trim();
    return /^FlyV1\s/.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

/**
 * How this process stops its host when idle. Fly sets FLY_APP_NAME and
 * FLY_MACHINE_ID in every Machine; their presence is what marks one.
 */
export function resolveFlyMachineStop(
    env: NodeJS.ProcessEnv,
    options: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): FlyMachineStop {
    const machineId = env.FLY_MACHINE_ID?.trim();
    if (!machineId) return { kind: 'not_fly' };
    // A Fly dashboard launch (#3827) runs ProPR and Redis in ONE container
    // (scripts/fly-launch-entrypoint.sh): the exit stops the Machine, and its
    // on-failure restart policy leaves it stopped after an exit 0.
    if (env[FLY_EXIT_STOPS_MACHINE_ENV]?.trim() === '1') return { kind: 'not_fly' };
    const app = env.FLY_APP_NAME?.trim();
    const token = env[FLY_MACHINE_STOP_TOKEN_ENV]?.trim();
    if (!app || !token) {
        const missing = [!app ? 'FLY_APP_NAME' : '', !token ? FLY_MACHINE_STOP_TOKEN_ENV : ''].filter(Boolean).join(' and ');
        return {
            kind: 'unavailable',
            problem: `a way to stop this Fly Machine (${missing} not set; an exit would leave Redis and the other containers running, so the Machine would stay started and billed; redeploy with propr deploy fly --idle-shutdown)`,
        };
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const url = `${(options.baseUrl ?? FLY_INTERNAL_MACHINES_API_URL).replace(/\/+$/, '')}/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/stop`;
    const authorization = flyMachineStopAuthorization(token);
    const stop: HostStop = async timeoutMs => {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
            // Empty: the Machine's stop_config (SIGTERM, 60s) applies.
            body: '{}',
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            // The token is never part of the message.
            const body = (await response.text().catch(() => '')).trim().slice(0, 200);
            throw new Error(`Fly Machines API stop of ${machineId} failed with HTTP ${response.status}${body ? `: ${body}` : ''}`);
        }
    };
    return { kind: 'ready', app, machineId, stop };
}

/** Why idle shutdown cannot stop this host (see {@link resolveFlyMachineStop}); null when it can. */
export function flyMachineStopProblem(env: NodeJS.ProcessEnv): string | null {
    const machineStop = resolveFlyMachineStop(env);
    return machineStop.kind === 'unavailable' ? machineStop.problem : null;
}
