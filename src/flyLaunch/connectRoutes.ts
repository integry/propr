/**
 * The ProPR App path's enrollment routes of the setup wizard (#3827): get a
 * one-time GitHub user token, from GitHub's device flow against the shared
 * App (deviceEnrollment.ts) or pasted while the App does not enable it, and
 * enroll this instance's relay token with it (connectSetup.ts).
 *
 *   POST /setup/connect/device         start a device sign-in
 *   GET  /setup/connect/device         the code page; checks GitHub on each refresh
 *   POST /setup/connect/device/cancel  drop it and return to the GitHub step
 *   POST /setup/connect/enroll         a pasted token, or the pick between
 *                                      installations after either
 *
 * The user token is never written to the volume, logged or rendered.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_PROPR_GH_RELAY_URL, enrollConnect, parseUserToken, relayTokenLabel, storeConnectEnrollment } from './connectSetup.js';
import { createDeviceEnrollment } from './deviceEnrollment.js';
import { DeviceFlowDisabledError, PROPR_APP_CLIENT_ID } from './deviceFlow.js';
import { GithubSetupError } from './githubSetup.js';
import type { LaunchConfig } from './launchConfig.js';
import type { LaunchStore } from './launchStore.js';
import { readForm } from './setupHttp.js';
import { deviceCodePage, githubPage, type DeviceSignIn, type GithubPageOptions, type InstanceInfo, type SetupStep } from './setupPages.js';
import { currentSetupStep } from './setupSteps.js';

export interface ConnectRouteDeps {
    store: LaunchStore;
    instance: InstanceInfo;
    publicUrl: string;
    appName: string;
    relayUrl: string;
    /** PROPR_GH_DEVICE_CLIENT_ID; the shared ProPR App's with the hosted relay. */
    deviceClientId?: string;
    labelHost?: string;
    fetcher?: typeof fetch;
    now?: () => number;
    keyExists: () => boolean;
    commitConfig: (update: (latest: LaunchConfig) => LaunchConfig) => Promise<LaunchConfig>;
    send: (response: ServerResponse, status: number, html: string) => void;
    redirect: (response: ServerResponse, location: string) => void;
    log: (message: string) => void;
}

interface ConnectRouteContext {
    request: IncomingMessage;
    response: ServerResponse;
    step: Exclude<SetupStep, 'claim'>;
}
type ConnectRoute = (context: ConnectRouteContext) => Promise<void> | void;

export function createConnectRoutes(deps: ConnectRouteDeps) {
    const { instance, publicUrl, relayUrl, send, redirect, log } = deps;
    // Another relay's App is unknown: without an explicit client ID it gets the pasted token only.
    const clientId = deps.deviceClientId ?? (relayUrl === DEFAULT_PROPR_GH_RELAY_URL ? PROPR_APP_CLIENT_ID : undefined);
    const device = createDeviceEnrollment({ clientId, fetcher: deps.fetcher, now: deps.now });
    const deviceSignIn = (): DeviceSignIn => (!clientId ? 'off' : device.available() ? 'available' : 'disabled');

    /** Enroll with a one-time GitHub user token; it is dropped afterwards. */
    const enrollWith = async (response: ServerResponse, userToken: string, installationId: string | undefined, fromDevice: boolean): Promise<void> => {
        const label = relayTokenLabel(deps.appName, deps.labelHost);
        const result = await enrollConnect({ userToken, installationId, label, relayUrl, fetcher: deps.fetcher });
        if (result.kind === 'pick') {
            // Only a device sign-in's token is kept for the pick (in memory, briefly); a pasted one is asked for again.
            if (fromDevice) device.hold(userToken);
            const page: GithubPageOptions = { installations: result.installations, heldToken: fromDevice, device: deviceSignIn() };
            return send(response, 200, githubPage(instance, publicUrl, page));
        }
        const { enrollment } = result;
        try {
            await deps.commitConfig(latest => {
                if (currentSetupStep(latest, deps.keyExists()) !== 'github') throw new GithubSetupError('Another setup step finished while this instance was being connected. Continue from here.');
                return storeConnectEnrollment(deps.store, latest, enrollment);
            });
        } catch (error) {
            // The relay token was issued for a result that is not kept; it must not stay valid.
            await result.revoke();
            throw error;
        }
        log(`fly-launch: connected to the ProPR App (installation ${enrollment.installationId}, ${enrollment.repositories.length} repositories${fromDevice ? ', GitHub device sign-in' : ''}); relay token ${enrollment.tokenPrefix || enrollment.tokenId} labelled ${enrollment.label} stored on the volume`);
        redirect(response, '/setup');
    };

    const enrollInstance: ConnectRoute = async ({ request, response, step }) => {
        if (step !== 'github') return redirect(response, '/setup');
        const form = await readForm(request);
        const held = form.has('githubToken') ? undefined : device.takeHeld();
        if (!held && !form.has('githubToken') && form.has('installation')) {
            throw new GithubSetupError('The GitHub sign-in for this choice has expired. Sign in with GitHub again.');
        }
        await enrollWith(response, held ?? parseUserToken(form.get('githubToken')), form.get('installation') ?? undefined, Boolean(held));
    };

    const startDeviceSignIn: ConnectRoute = async ({ response, step }) => {
        if (step !== 'github') return redirect(response, '/setup');
        try {
            await device.start();
        } catch (error) {
            // Not an error to show: the step offers the pasted token, with a note why.
            if (error instanceof DeviceFlowDisabledError) return send(response, 200, githubPage(instance, publicUrl, { device: deviceSignIn() }));
            throw error;
        }
        log('fly-launch: GitHub device sign-in started for relay enrollment');
        redirect(response, '/setup/connect/device');
    };

    const deviceSignInProgress: ConnectRoute = async ({ response, step }) => {
        if (step !== 'github') return redirect(response, '/setup');
        const progress = await device.poll();
        if (progress.kind === 'none') return redirect(response, '/setup');
        if (progress.kind === 'waiting') return send(response, 200, deviceCodePage(instance, progress));
        await enrollWith(response, progress.token, undefined, true);
    };

    const cancelDeviceSignIn: ConnectRoute = ({ response }) => {
        device.cancel();
        redirect(response, '/setup');
    };

    return { deviceSignIn, enrollInstance, startDeviceSignIn, deviceSignInProgress, cancelDeviceSignIn };
}
