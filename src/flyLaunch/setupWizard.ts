/**
 * The first-visit setup wizard of a Fly dashboard launch (#3827). It listens
 * on the API port while the instance is unconfigured, so the Fly proxy and
 * health checks see a healthy Machine, and closes for good once setup is
 * complete; the launch entry then starts the control plane in this process.
 *
 * Access (setupAccess.ts): the setup code from the logs claims the instance
 * for one browser (an HttpOnly, SameSite=Lax cookie on /setup). Every step
 * and every GitHub callback needs that cookie and a state value this wizard
 * issued; POSTs must come from the instance's own origin.
 *
 * Steps, in order; each is resumable because its result is on the volume:
 *   claim → GitHub, one of
 *     - the ProPR App (default, connectSetup.ts): install the shared App,
 *       enroll a relay token → register the sign-in OAuth App;
 *     - your own App (advanced): manifest flow → install;
 *   → administrator sign-in → agent runtime → finish (idle shutdown opt-in;
 *   on the ProPR App path it registers the /wake URL with Connect).
 *
 * Writes: every step's handler awaits GitHub or a runtime check before it
 * saves, so two of them can overlap (a slow runtime check and Finish). All
 * writes go through one queue (`commitConfig`): each re-reads the stored
 * config inside the queue, builds its change on that, and is refused with
 * 409 once `completedAt` is set, so a late write never replaces the finished
 * config with a stale snapshot and restarts the wizard.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GITHUB_APP_KEY_FILE, readLaunchConfig, writeLaunchConfig, type LaunchConfig, type LaunchRuntime } from './launchConfig.js';
import type { LaunchStore } from './launchStore.js';
import { SETUP_CLAIM_COOKIE, type SetupAccess } from './setupAccess.js';
import {
    adminRedirectUri, convertManifestCode, GithubSetupError, githubAppInstallUrl, githubAppRegistrationUrl, githubOAuthAuthorizeUrl,
    launchGithubAppManifest, signInAdministrator, storeManifestCredentials, verifyInstallation, SETUP_PATHS,
} from './githubSetup.js';
import {
    DEFAULT_PROPR_GH_RELAY_URL, enrollConnect, OAUTH_CALLBACK_PATH, parseSignInClient, parseUserToken, registerWakeTarget,
    relayTokenLabel, storeConnectEnrollment, storeSignInClient,
} from './connectSetup.js';
import { countAppMachines, RUNTIME_ENV_KEYS, spritesNamePrefix, validateRuntimeChoice, type RuntimeValidators } from './runtimeValidation.js';
import type { InstanceInfo } from './setupLayout.js';
import { readCookie, readForm, sendSetupAsset } from './setupHttp.js';
import { currentSetupStep, githubPath } from './setupSteps.js';
import {
    adminPage, claimedElsewherePage, claimPage, finishPage, githubPage, installPage, manifestRedirectPage, runtimePage, setupCompletedPage,
    signInAppPage, startingPage, type GithubPageOptions, type RuntimeFormValues, type SetupStep,
} from './setupPages.js';

export { currentSetupStep, githubPath };

const STATE_TTL_MS = 60 * 60_000;
export const FLY_LAUNCH_IDLE_SHUTDOWN_AFTER = '15m';
/**
 * Nothing (no code, no state) is sent to GitHub, but same-origin form POSTs
 * keep their Origin header: under `no-referrer` Chromium sends `Origin: null`,
 * which the origin check below would refuse.
 */
export const REFERRER_POLICY = 'same-origin';

export interface SetupWizardOptions {
    store: LaunchStore;
    access: SetupAccess;
    publicUrl: string;
    controlPlaneApp?: string;
    /** The ProPR Connect relay (PROPR_GH_RELAY_URL); the hosted one by default. */
    relayUrl?: string;
    /** The host in the relay token label `fly:<app>@<host>`; os.hostname() by default. */
    labelHost?: string;
    /** PROPR_INSTANCE_ID as the control plane will see it (names this instance's Sprites); the app name by default. */
    instanceId?: string;
    /** DATA_DIR, where the Sprites deployment marker is kept; ./data by default. */
    dataDir?: string;
    /** This app's Machines, for the "Agent Machines at once" default; countAppMachines by default. */
    countMachines?: () => Promise<number | undefined>;
    fetcher?: typeof fetch;
    validators?: RuntimeValidators;
    log?: (message: string) => void;
}

export interface SetupWizard {
    /** Routes one request (exported for tests). */
    handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
    /** Resolves once setup is complete. */
    readonly completed: Promise<LaunchConfig>;
}

type StateKind = 'manifest' | 'install' | 'admin';

/** A setup write that arrived after Finish saved `completedAt`; answered with 409. */
export class SetupCompletedError extends Error {
    constructor() { super('setup already completed'); }
}

const RUNTIME_LABELS: Record<LaunchRuntime, string> = { sprites: 'Sprites', 'fly-machines': 'Fly Machines', none: 'none yet (control plane only)' };

export function createSetupWizard(options: SetupWizardOptions): SetupWizard {
    const { store, access, publicUrl } = options;
    const origin = new URL(publicUrl).origin;
    const secureCookie = new URL(publicUrl).protocol === 'https:';
    const log = options.log ?? (message => console.log(message));
    const states = new Map<string, { kind: StateKind; expires: number }>();
    let finish!: (config: LaunchConfig) => void;
    const completed = new Promise<LaunchConfig>(resolve => { finish = resolve; });
    let done = false;
    // The write queue: one setup write at a time, each on the config as stored when its turn comes.
    let writes: Promise<unknown> = Promise.resolve();
    const commitConfig = (update: (latest: LaunchConfig) => LaunchConfig): Promise<LaunchConfig> => {
        const write = writes.then(() => {
            const latest = readLaunchConfig(store);
            if (latest.completedAt) throw new SetupCompletedError();
            const next = update(latest);
            writeLaunchConfig(store, next);
            return next;
        });
        writes = write.catch(() => undefined);
        return write;
    };

    const keyExists = (): boolean => existsSync(store.path(GITHUB_APP_KEY_FILE));
    const issueState = (kind: StateKind): string => {
        const state = randomBytes(24).toString('base64url');
        states.set(state, { kind, expires: Date.now() + STATE_TTL_MS });
        return state;
    };
    const takeState = (state: string | null, kind: StateKind): boolean => {
        const entry = state ? states.get(state) : undefined;
        if (!entry || entry.kind !== kind || entry.expires < Date.now()) return false;
        states.delete(state!);
        return true;
    };

    const send = (response: ServerResponse, status: number, html: string, nonce?: string): void => {
        response.writeHead(status, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': REFERRER_POLICY,
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'`,
        });
        response.end(html);
    };
    const redirect = (response: ServerResponse, location: string, cookie?: string): void => {
        response.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': REFERRER_POLICY, ...(cookie ? { 'Set-Cookie': cookie } : {}) });
        response.end();
    };

    const appName = options.controlPlaneApp || new URL(publicUrl).hostname.split('.')[0];
    const instance: InstanceInfo = { host: new URL(publicUrl).host, ...(options.controlPlaneApp ? { app: options.controlPlaneApp } : {}) };
    const spritesPrefix = (): string => spritesNamePrefix(options.instanceId || appName, options.dataDir || join(process.cwd(), 'data'));
    // Counted once: the answer does not change while the wizard runs.
    let machines: Promise<number | undefined> | undefined;
    const controlPlaneMachines = (): Promise<number | undefined> =>
        (machines ??= (options.countMachines ?? (() => (options.controlPlaneApp ? countAppMachines(options.controlPlaneApp) : Promise.resolve(undefined))))());
    const showRuntime = async (config: LaunchConfig, error?: string, values: RuntimeFormValues = {}): Promise<string> => runtimePage(instance, {
        admin: config.admin?.login ?? config.env.PROPR_ADMIN_USERS ?? '', controlPlaneApp: options.controlPlaneApp ?? '',
        spritesPrefix: spritesPrefix(), controlPlaneMachines: await controlPlaneMachines(),
    }, error, { ...values, path: githubPath(config) });
    const relayUrl = options.relayUrl ?? DEFAULT_PROPR_GH_RELAY_URL;
    const adminCallback = (config: LaunchConfig): string =>
        adminRedirectUri(publicUrl, githubPath(config) === 'connect' ? OAUTH_CALLBACK_PATH : SETUP_PATHS.admin);

    /** `form`: which GitHub form an error came from, so the page shows it there. */
    const stepPage = async (config: LaunchConfig, error?: string, form?: 'connect' | 'own-app'): Promise<string> => {
        const path = githubPath(config);
        switch (currentSetupStep(config, keyExists())) {
            case 'github': return githubPage(instance, publicUrl, form === 'own-app' ? { ownAppError: error } : { connectError: error });
            case 'install': return installPage(instance, config.github!.slug, error);
            case 'signin-app': return signInAppPage(instance, publicUrl, config.connect?.accountLogin ?? '', error);
            case 'admin': return adminPage(instance, (config.env.GITHUB_REPOS_TO_MONITOR ?? '').split(',').filter(Boolean), error, path);
            case 'runtime': return showRuntime(config, error);
            case 'finish': return finishPage(instance, RUNTIME_LABELS[config.runtime!], error, { path, checked: config.runtimeCheck });
        }
    };

    interface RouteContext {
        request: IncomingMessage;
        response: ServerResponse;
        url: URL;
        config: LaunchConfig;
        step: Exclude<SetupStep, 'claim'>;
    }
    type Route = (context: RouteContext) => Promise<void> | void;

    const startManifest: Route = async ({ request, response }) => {
        const form = await readForm(request);
        const manifest = launchGithubAppManifest(publicUrl, form.get('name') ?? undefined);
        const action = githubAppRegistrationUrl(form.get('org') ?? undefined, issueState('manifest'));
        const nonce = randomBytes(16).toString('base64');
        send(response, 200, manifestRedirectPage(instance, action, manifest, nonce), nonce);
    };

    const manifestCreated: Route = async ({ response, url }) => {
        if (!takeState(url.searchParams.get('state'), 'manifest')) throw new GithubSetupError('This GitHub App link is not from this setup session. Start the step again.');
        const credentials = await convertManifestCode(url.searchParams.get('code') ?? '', options.fetcher);
        // The key file is written inside the queue too: it must not change once setup is complete.
        await commitConfig(latest => storeManifestCredentials(store, latest, credentials));
        log(`fly-launch: created GitHub App ${credentials.slug} (id ${credentials.id}); credentials stored on the volume`);
        redirect(response, githubAppInstallUrl(credentials.slug, issueState('install')));
    };

    const startInstall: Route = ({ response, config }) => {
        if (!config.github) return redirect(response, '/setup');
        redirect(response, githubAppInstallUrl(config.github.slug, issueState('install')));
    };

    const installed: Route = async ({ response, url, config, step }) => {
        // GitHub sends no state after an install started from the App's own page; accept those only while installing.
        const state = url.searchParams.get('state');
        if (state ? !takeState(state, 'install') : step !== 'install') throw new GithubSetupError('This installation link is not from this setup session. Install again.');
        if (!config.github) throw new GithubSetupError('Create the GitHub App first.');
        const pem = readFileSync(store.path(GITHUB_APP_KEY_FILE), 'utf8');
        const installationId = url.searchParams.get('installation_id') ?? '';
        const { repositories } = await verifyInstallation(config.github.appId, pem, installationId, options.fetcher);
        const appId = config.github.appId;
        await commitConfig(latest => {
            if (latest.github?.appId !== appId) throw new GithubSetupError('The GitHub App changed while the installation was checked. Install again.');
            const env: Record<string, string> = { ...latest.env, GH_INSTALLATION_ID: installationId };
            if (repositories.length) env.GITHUB_REPOS_TO_MONITOR = repositories.join(',');
            else delete env.GITHUB_REPOS_TO_MONITOR;
            return { ...latest, env };
        });
        log(`fly-launch: GitHub App installed (installation ${installationId}, ${repositories.length} repositories)`);
        redirect(response, '/setup');
    };

    const enrollInstance: Route = async ({ request, response, step }) => {
        if (step !== 'github') return redirect(response, '/setup');
        const form = await readForm(request);
        const userToken = parseUserToken(form.get('githubToken'));
        const label = relayTokenLabel(options.controlPlaneApp || new URL(publicUrl).hostname.split('.')[0], options.labelHost);
        const result = await enrollConnect({ userToken, installationId: form.get('installation') ?? undefined, label, relayUrl, fetcher: options.fetcher });
        if (result.kind === 'pick') {
            const page: GithubPageOptions = { installations: result.installations };
            return send(response, 200, githubPage(instance, publicUrl, page));
        }
        const { enrollment } = result;
        try {
            await commitConfig(latest => {
                if (currentSetupStep(latest, keyExists()) !== 'github') throw new GithubSetupError('Another setup step finished while this instance was being connected. Continue from here.');
                return storeConnectEnrollment(store, latest, enrollment);
            });
        } catch (error) {
            // The relay token was issued for a result that is not kept; it must not stay valid.
            await result.revoke();
            throw error;
        }
        log(`fly-launch: connected to the ProPR App (installation ${enrollment.installationId}, ${enrollment.repositories.length} repositories); relay token ${enrollment.tokenPrefix || enrollment.tokenId} labelled ${enrollment.label} stored on the volume`);
        redirect(response, '/setup');
    };

    const showSignInApp: Route = ({ response, config, step }) => {
        if (step !== 'signin-app' && !(config.connect && step === 'admin')) return redirect(response, '/setup');
        send(response, 200, signInAppPage(instance, publicUrl, config.connect?.accountLogin ?? ''));
    };

    const saveSignInApp: Route = async ({ request, response, config, step }) => {
        if (!config.connect || (step !== 'signin-app' && step !== 'admin')) return redirect(response, '/setup');
        const form = await readForm(request);
        let client: { clientId: string; clientSecret: string };
        try {
            client = parseSignInClient(form.get('clientId'), form.get('clientSecret'));
        } catch (error) {
            return send(response, 400, signInAppPage(instance, publicUrl, config.connect.accountLogin, (error as Error).message));
        }
        await commitConfig(latest => {
            const latestStep = currentSetupStep(latest, keyExists());
            if (!latest.connect || (latestStep !== 'signin-app' && latestStep !== 'admin')) throw new GithubSetupError('An earlier setup step changed. Continue from here.');
            return storeSignInClient(latest, client);
        });
        log('fly-launch: sign-in OAuth App stored on the volume');
        redirect(response, '/setup');
    };

    const startSignIn: Route = ({ response, config }) => {
        const clientId = config.env.GH_OAUTH_CLIENT_ID;
        redirect(response, clientId ? githubOAuthAuthorizeUrl(clientId, adminCallback(config), issueState('admin')) : '/setup');
    };

    const adminSignedIn: Route = async ({ response, url, config }) => {
        if (!takeState(url.searchParams.get('state'), 'admin')) throw new GithubSetupError('This sign-in link is not from this setup session. Sign in again.');
        const { GH_OAUTH_CLIENT_ID: clientId, GH_OAUTH_CLIENT_SECRET: clientSecret } = config.env;
        if (!clientId || !clientSecret) throw new GithubSetupError(config.connect ? 'Register the sign-in app first.' : 'Create the GitHub App first.');
        const admin = await signInAdministrator({ clientId, clientSecret }, url.searchParams.get('code') ?? '', adminCallback(config), options.fetcher);
        await commitConfig(latest => {
            if (latest.env.GH_OAUTH_CLIENT_ID !== clientId) throw new GithubSetupError('The sign-in app changed during the sign-in. Sign in again.');
            return { ...latest, admin, env: { ...latest.env, PROPR_ADMIN_USERS: admin.login } };
        });
        log(`fly-launch: first administrator is ${admin.login}`);
        redirect(response, '/setup');
    };

    const saveRuntime: Route = async ({ request, response, config, step }) => {
        if (step !== 'runtime' && step !== 'finish') return redirect(response, '/setup');
        const form = await readForm(request);
        const field = (name: string): string | undefined => form.get(name) ?? undefined;
        const runtime = (field('runtime') ?? '') as LaunchRuntime;
        const result = await validateRuntimeChoice({
            runtime, spritesToken: field('spritesToken'), flyApp: field('flyApp'), flyToken: field('flyToken'),
            flyImage: field('flyImage'), flyMachinesMax: field('flyMachinesMax'),
        }, { controlPlaneApp: options.controlPlaneApp, spritesPrefix: spritesPrefix() }, options.validators);
        if (!result.ok) {
            const kept = { runtime, flyApp: field('flyApp'), flyImage: field('flyImage'), flyMachinesMax: field('flyMachinesMax') };
            return send(response, 400, await showRuntime(config, result.error, kept));
        }
        await commitConfig(latest => {
            const latestStep = currentSetupStep(latest, keyExists());
            if (latestStep !== 'runtime' && latestStep !== 'finish') throw new GithubSetupError('An earlier setup step changed while the runtime was checked. Continue from here.');
            const env = { ...latest.env };
            for (const key of RUNTIME_ENV_KEYS) delete env[key];
            const next: LaunchConfig = { ...latest, runtime, env: { ...env, ...result.env } };
            if (result.summary) next.runtimeCheck = result.summary;
            else delete next.runtimeCheck;
            return next;
        });
        log(`fly-launch: agent runtime ${runtime} checked and saved`);
        redirect(response, '/setup');
    };

    /**
     * Idle shutdown on the ProPR App path: Connect must know where to wake the
     * stopped Machine, or GitHub events would wait until a browser starts it.
     */
    const registerWake = async (config: LaunchConfig): Promise<string | undefined> => {
        const relayToken = config.env.PROPR_GH_RELAY_TOKEN;
        if (!config.connect || !relayToken) return undefined;
        const wakeUrl = `${publicUrl}/wake`;
        try {
            await registerWakeTarget({ relayUrl: config.env.PROPR_GH_RELAY_URL || relayUrl, bearer: relayToken, fetcher: options.fetcher ?? fetch }, wakeUrl);
        } catch (error) {
            throw new GithubSetupError(`ProPR Connect could not register this instance's wake URL (${(error as Error).message}) Leave idle shutdown off, or try again.`);
        }
        return wakeUrl;
    };

    const finishSetup: Route = async ({ request, response, config, step }) => {
        if (step !== 'finish') return redirect(response, '/setup');
        const form = await readForm(request);
        const idle = form.get('idleShutdown') === 'on';
        const wakeTarget = idle ? await registerWake(config) : undefined;
        const final = await commitConfig(latest => {
            if (currentSetupStep(latest, keyExists()) !== 'finish') throw new GithubSetupError('An earlier setup step changed. Check it and finish again.');
            const env = { ...latest.env };
            delete env.PROPR_IDLE_SHUTDOWN;
            delete env.PROPR_IDLE_SHUTDOWN_AFTER;
            if (idle) Object.assign(env, { PROPR_IDLE_SHUTDOWN: 'on', PROPR_IDLE_SHUTDOWN_AFTER: FLY_LAUNCH_IDLE_SHUTDOWN_AFTER });
            const connect = latest.connect && wakeTarget ? { ...latest.connect, wakeTarget } : latest.connect;
            return { ...latest, env, ...(connect ? { connect } : {}), completedAt: new Date().toISOString() };
        });
        access.close();
        done = true;
        log(`fly-launch: setup complete (idle shutdown ${idle ? 'on' : 'off'}); starting ProPR`);
        response.once('finish', () => finish(final));
        // The wizard server closes after this answer; the browser must not reuse the connection.
        response.shouldKeepAlive = false;
        send(response, 200, startingPage(instance));
    };

    const routes: Record<string, Route> = {
        'GET /setup': async ({ response, config }) => send(response, 200, await stepPage(config)),
        'POST /setup/github/start': startManifest,
        [`GET ${SETUP_PATHS.created}`]: manifestCreated,
        'GET /setup/github/install': startInstall,
        [`GET ${SETUP_PATHS.installed}`]: installed,
        'POST /setup/connect/enroll': enrollInstance,
        'GET /setup/connect/signin-app': showSignInApp,
        'POST /setup/connect/signin-app': saveSignInApp,
        'GET /setup/github/signin': startSignIn,
        [`GET ${SETUP_PATHS.admin}`]: adminSignedIn,
        'POST /setup/runtime': saveRuntime,
        'POST /setup/finish': finishSetup,
    };

    async function claimantRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
        const config = readLaunchConfig(store);
        const route = routes[`${request.method} ${url.pathname}`];
        if (!route) return redirect(response, '/setup');
        try {
            await route({ request, response, url, config, step: currentSetupStep(config, keyExists()) });
        } catch (error) {
            if (error instanceof SetupCompletedError) {
                log('fly-launch: a setup step finished after setup was completed; its result was not saved');
                return send(response, 409, setupCompletedPage(instance));
            }
            const message = error instanceof GithubSetupError ? error.message : 'Something went wrong. Try again.';
            if (!(error instanceof GithubSetupError)) log(`fly-launch: setup step failed: ${(error as Error)?.message ?? 'unknown error'}`);
            send(response, 400, await stepPage(readLaunchConfig(store), message, url.pathname.startsWith('/setup/connect/') ? 'connect' : 'own-app'));
        }
    }

    async function claimRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
        let code = '';
        try { code = (await readForm(request)).get('code') ?? ''; } catch { /* oversized: treated as a wrong code */ }
        const result = access.claim(code);
        if (result.ok) {
            log('fly-launch: setup claimed by a browser; the setup code no longer works');
            const cookie = `${SETUP_CLAIM_COOKIE}=${result.token}; Path=/setup; HttpOnly; SameSite=Lax; Max-Age=86400${secureCookie ? '; Secure' : ''}`;
            return redirect(response, '/setup', cookie);
        }
        if (result.reason === 'already_claimed') return send(response, 403, claimedElsewherePage(instance));
        const limited = result.reason === 'rate_limited';
        send(response, limited ? 429 : 400, claimPage(instance, limited ? 'Too many wrong codes. Wait a minute and try again.' : 'That code is not valid. Copy the latest code from the logs.'));
    }

    /** /health and everything outside /setup while the wizard runs. */
    function outsideSetup(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
        if (sendSetupAsset(request, response, url)) return true;
        if (url.pathname === '/health') {
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ status: 'ok', setup: done ? 'complete' : 'pending' }));
            return true;
        }
        if (done) {
            send(response, 503, startingPage(instance));
            return true;
        }
        if (url.pathname.startsWith('/setup')) return false;
        // The ProPR App path's sign-in app has one callback, the API's; while the
        // wizard runs it continues on the wizard's admin callback, where the
        // claim cookie (Path=/setup) and the state are checked.
        if (url.pathname === OAUTH_CALLBACK_PATH && request.method === 'GET') {
            redirect(response, `${SETUP_PATHS.admin}${url.search}`);
            return true;
        }
        if (request.method === 'GET' || request.method === 'HEAD') {
            redirect(response, '/setup');
        } else {
            response.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
            response.end('ProPR is not set up yet.');
        }
        return true;
    }

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? '/', origin);
        if (outsideSetup(request, response, url)) return;
        const requestOrigin = request.headers.origin;
        if (request.method === 'POST' && requestOrigin && requestOrigin !== origin) {
            return send(response, 403, claimPage(instance, 'This form must be sent from the instance itself.'));
        }
        if (access.isClaimant(readCookie(request, SETUP_CLAIM_COOKIE))) return claimantRoute(request, response, url);
        if (access.claimed()) return send(response, 403, claimedElsewherePage(instance));
        if (request.method === 'POST' && url.pathname === '/setup/claim') return claimRoute(request, response);
        send(response, 200, claimPage(instance));
    }

    return { handle, completed };
}

/** How long in-flight wizard requests get to answer after Finish before their connections are cut. */
export const SETUP_WIZARD_CLOSE_GRACE_MS = 5_000;

export interface RunSetupWizardOptions extends SetupWizardOptions {
    host: string;
    port: number;
    /** Defaults to SETUP_WIZARD_CLOSE_GRACE_MS. */
    closeGraceMs?: number;
    /** Called with the bound port once the wizard listens (tests listen on port 0). */
    onListening?: (port: number) => void;
}

/**
 * Serve the wizard until setup is complete; resolves with the final config
 * once the server has closed. After Finish the listener closes at once (no
 * new connections; the port is free for the control plane), idle keep-alive
 * connections are closed, and requests still in flight, such as a runtime
 * check that was pending when Finish landed, may still send their answer
 * (409) on a connection that then closes. Whatever is left after the grace
 * period is cut, so shutdown stays bounded.
 */
export async function runSetupWizard(options: RunSetupWizardOptions): Promise<LaunchConfig> {
    const wizard = createSetupWizard(options);
    const inFlight = new Set<ServerResponse>();
    let closing = false;
    const server: Server = createServer((request, response) => {
        // Once closing, no connection is kept alive after its answer.
        if (closing) response.shouldKeepAlive = false;
        inFlight.add(response);
        response.once('close', () => inFlight.delete(response));
        wizard.handle(request, response).catch(() => {
            if (!response.headersSent) response.writeHead(500).end();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => resolve());
    });
    options.onListening?.((server.address() as { port: number }).port);
    const config = await wizard.completed;
    closing = true;
    for (const response of inFlight) if (!response.headersSent) response.shouldKeepAlive = false;
    await new Promise<void>(resolve => {
        const force = setTimeout(() => server.closeAllConnections(), options.closeGraceMs ?? SETUP_WIZARD_CLOSE_GRACE_MS);
        server.close(() => { clearTimeout(force); resolve(); });
        server.closeIdleConnections();
    });
    return config;
}
