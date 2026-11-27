/**
 * Fly dashboard launch (#3827): the first-visit setup wizard over HTTP, with
 * GitHub and the runtime checks faked. Covers access control (setup code,
 * single claim, wizard closed once done) and storing the manifest-flow
 * credentials. Run with: npx tsx --test test/flyLaunchWizard.test.ts
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { readdirSync } from 'node:fs';
import { PROPR_APP_INSTALL_URL, storeConnectEnrollment, type ConnectEnrollment } from '../src/flyLaunch/connectSetup.ts';
import { storeManifestCredentials, type ManifestCredentials } from '../src/flyLaunch/githubSetup.ts';
import { applyLaunchEnv, GITHUB_APP_KEY_FILE, readLaunchConfig, setupRequired, type LaunchConfig } from '../src/flyLaunch/launchConfig.ts';
import { createLaunchStore, type LaunchStore } from '../src/flyLaunch/launchStore.ts';
import { createSetupAccess, SETUP_ACCESS_FILE, SETUP_CLAIM_COOKIE } from '../src/flyLaunch/setupAccess.ts';
import { createSetupWizard, runSetupWizard, SETUP_WIZARD_CLOSE_GRACE_MS, type SetupWizardOptions } from '../src/flyLaunch/setupWizard.ts';
import { DEFAULT_AGENT_IMAGE, spritesNamePrefix, SPRITES_TOKENS_URL, type RuntimeValidators } from '../src/flyLaunch/runtimeValidation.ts';
import { WIZARD_SCRIPT } from '../src/flyLaunch/setupLayout.ts';
import { PROPR_VERSION } from '@propr/shared';

const PUBLIC_URL = 'https://propr-test.fly.dev';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function credentials(overrides: Partial<ManifestCredentials> = {}): ManifestCredentials {
    return {
        id: 42, slug: 'propr-test', html_url: 'https://github.com/apps/propr-test', owner: { login: 'octo' },
        pem: PEM, webhook_secret: 'hook-secret', client_id: 'Iv1.client', client_secret: 'client-secret', ...overrides,
    };
}

const USER_TOKEN = `github_pat_${'u'.repeat(40)}`;
const RELAY_TOKEN = 'prt_relay_secret_value';

/** The hosted relay (propr-routing), as the CLI's relay client sees it. */
interface RelayFake {
    installations: Array<{ installation_id: number; account_login: string; account_type: string }>;
    /** Status the named route answers instead of success. */
    fail: Partial<Record<'me' | 'enroll' | 'mint' | 'wake', number>>;
    /** Held until resolved, before POST /v1/relay-tokens answers. */
    holdEnroll?: Promise<void>;
    enrollStarted?: () => void;
    enrolled: Array<{ installation_id: number; label: string }>;
    revoked: Array<{ installation_id: number; token_id: string }>;
    wake: Array<{ url: string }>;
    /** `<route> <Authorization header>` for every relay call. */
    auth: string[];
}

function relayFake(overrides: Partial<RelayFake> = {}): RelayFake {
    return {
        installations: [{ installation_id: 77, account_login: 'octo', account_type: 'User' }],
        fail: {}, enrolled: [], revoked: [], wake: [], auth: [], ...overrides,
    };
}

async function relayRoute(relay: RelayFake, key: string, init: RequestInit | undefined, json: (body: unknown, status?: number) => Response): Promise<Response | undefined> {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const failed = (route: keyof RelayFake['fail']) => relay.fail[route] && json({ error: { code: 'fake' } }, relay.fail[route]);
    const record = (route: string) => relay.auth.push(`${route} ${auth}`);
    switch (key) {
        case 'GET webhook.propr.dev/v1/auth/me':
            record('me');
            return failed('me') || json({ username: 'octo', installations: relay.installations });
        case 'POST webhook.propr.dev/v1/relay-tokens':
            record('enroll');
            relay.enrollStarted?.();
            await relay.holdEnroll;
            if (failed('enroll')) return failed('enroll') as Response;
            relay.enrolled.push(body);
            return json({ token: RELAY_TOKEN, token_id: 'tok-1', token_prefix: 'prt_rel', installation_id: body.installation_id, label: body.label }, 201);
        case 'POST webhook.propr.dev/v1/relay-tokens/revoke':
            record('revoke');
            relay.revoked.push(body);
            return json({ status: 'revoked', token_id: body.token_id });
        case 'POST webhook.propr.dev/v1/installation-token':
            record('mint');
            return failed('mint') || json({ token: 'ghs_relay_installation', expires_at: new Date(Date.now() + 3600_000).toISOString() });
        case 'PUT webhook.propr.dev/v1/wake-target':
            record('wake');
            if (failed('wake')) return failed('wake') as Response;
            relay.wake.push(body);
            return json({ wake_target: { token_id: 'tok-1', url: body.url, secret: 'pws_generated' } });
        default: return undefined;
    }
}

function fakeGithub(calls: string[], relay: RelayFake = relayFake()): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const key = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
        calls.push(key);
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        const relayed = await relayRoute(relay, key, init, json);
        if (relayed) return relayed;
        switch (key) {
            case 'POST api.github.com/app-manifests/manifest-code/conversions': return json(credentials(), 201);
            case 'GET api.github.com/app/installations/7': return json({ id: 7, app_id: 42 });
            case 'GET api.github.com/app/installations/8': return json({ id: 8, app_id: 99 });
            case 'POST api.github.com/app/installations/7/access_tokens': return json({ token: 'ghs_installation' }, 201);
            case 'GET api.github.com/installation/repositories': return json({ repositories: [{ full_name: 'octo/repo' }, { full_name: 'octo/other' }] });
            case 'POST github.com/login/oauth/access_token': return json({ access_token: 'gho_user' });
            case 'GET api.github.com/user': return json({ login: 'Octo', id: 1001 });
            default: return json({ message: 'not found' }, 404);
        }
    }) as typeof fetch;
}

interface Harness {
    store: LaunchStore;
    relay: RelayFake;
    options: SetupWizardOptions;
    /** Resolves with the final config: on Finish, or (`run`) once runSetupWizard has closed its server. */
    completed: Promise<LaunchConfig>;
    port: number;
    calls: string[];
    logs: string[];
    code: string;
    request(path: string, options?: { method?: string; form?: Record<string, string>; cookie?: string; origin?: string }): Promise<Response>;
}

/**
 * `run: true` serves through the real runSetupWizard lifecycle (listen, Finish,
 * bounded close) instead of a test server around createSetupWizard.
 */
interface WizardOverrides {
    validators?: Partial<RuntimeValidators>;
    run?: boolean;
    closeGraceMs?: number;
    relay?: RelayFake;
    /** Reuse a volume (a restart); the claim on it carries over. */
    store?: LaunchStore;
    countMachines?: () => Promise<number | undefined>;
}

async function startWizard(overrides: WizardOverrides = {}): Promise<Harness> {
    let store = overrides.store;
    if (!store) {
        const root = mkdtempSync(join(tmpdir(), 'fly-launch-wizard-'));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        store = createLaunchStore(join(root, 'fly-launch'));
    }
    const access = createSetupAccess(store);
    const code = access.issueCode()!;
    const relay = overrides.relay ?? relayFake();
    const calls: string[] = [];
    const logs: string[] = [];
    const options: SetupWizardOptions = {
        store, access, publicUrl: PUBLIC_URL, controlPlaneApp: 'propr-test', labelHost: 'machine-1', fetcher: fakeGithub(calls, relay), log: message => logs.push(message),
        dataDir: mkdtempSync(join(tmpdir(), 'fly-launch-data-')), countMachines: overrides.countMachines ?? (async () => undefined),
        validators: {
            sprites: async token => { if (token !== 'good-sprites') throw new Error('401'); },
            flyApp: async (app, token) => (app === 'propr-agents' && token === 'FlyV1 agent' ? 200 : 403),
            ...overrides.validators,
        },
    };
    let port: number;
    let completed: Promise<LaunchConfig>;
    if (overrides.run) {
        let listening!: (port: number) => void;
        const bound = new Promise<number>(resolve => { listening = resolve; });
        completed = runSetupWizard({ ...options, host: '127.0.0.1', port: 0, closeGraceMs: overrides.closeGraceMs, onListening: listening });
        completed.catch(() => undefined);
        port = await Promise.race([bound, completed.then(() => { throw new Error('the wizard closed before listening'); })]);
    } else {
        const wizard = createSetupWizard(options);
        completed = wizard.completed;
        const server: Server = createServer((req, res) => { void wizard.handle(req, res); });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
        port = (server.address() as { port: number }).port;
    }
    const base = `http://127.0.0.1:${port}`;
    return {
        store, relay, options, completed, port, calls, logs, code,
        request(path, options = {}) {
            const headers: Record<string, string> = {};
            if (options.cookie) headers.Cookie = options.cookie;
            if (options.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
            if (options.method === 'POST') headers.Origin = options.origin ?? PUBLIC_URL;
            return fetch(`${base}${path}`, {
                method: options.method ?? 'GET', headers, redirect: 'manual',
                body: options.form ? new URLSearchParams(options.form).toString() : undefined,
            });
        },
    };
}

async function claim(h: Harness): Promise<string> {
    const response = await h.request('/setup/claim', { method: 'POST', form: { code: h.code } });
    assert.equal(response.status, 303);
    const setCookie = response.headers.get('set-cookie')!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/);
    return setCookie.split(';')[0];
}

const stateIn = (text: string): string => /state=([A-Za-z0-9_-]+)/.exec(text.replace(/&amp;/g, '&'))![1];

test('an unclaimed instance shows only the code form; health stays up; other paths send to /setup', async () => {
    const h = await startWizard();
    const page = await (await h.request('/setup')).text();
    assert.match(page, /Enter the setup code/);
    assert.equal((await h.request('/health')).status, 200);
    const other = await h.request('/settings');
    assert.equal(other.status, 303);
    assert.equal(other.headers.get('location'), '/setup');
    assert.equal((await h.request('/webhook', { method: 'POST' })).status, 503);
    // Steps are refused without the claim, even straight to a callback.
    assert.match(await (await h.request('/setup/github/created?code=manifest-code&state=x')).text(), /Enter the setup code/);
    assert.equal(h.calls.length, 0);
});

test('a wrong code does not claim; the right code claims once and a second browser is shut out', async () => {
    const h = await startWizard();
    const form = await h.request('/setup');
    // Under no-referrer browsers send `Origin: null` with the form POST, which the origin check refuses.
    assert.equal(form.headers.get('referrer-policy'), 'same-origin');
    const wrong = await h.request('/setup/claim', { method: 'POST', form: { code: 'AAAA-AAAA-AAAA' } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.headers.get('set-cookie'), null);
    const cookie = await claim(h);
    assert.match(await (await h.request('/setup', { cookie })).text(), /Connect GitHub/);
    const stranger = await h.request('/setup/claim', { method: 'POST', form: { code: h.code } });
    assert.equal(stranger.status, 403);
    assert.equal((await h.request('/setup')).status, 403);
    assert.equal((await h.request('/setup', { cookie: `${SETUP_CLAIM_COOKIE}=forged` })).status, 403);
});

test('POSTs from another origin are refused', async () => {
    const h = await startWizard();
    const response = await h.request('/setup/claim', { method: 'POST', form: { code: h.code }, origin: 'https://evil.example' });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
});

test('the full wizard: manifest flow, install, administrator, runtime, finish; then it is closed for good', async () => {
    const h = await startWizard();
    const cookie = await claim(h);

    // 1. The manifest form posts to GitHub with this instance's URLs and a state.
    const start = await h.request('/setup/github/start', { method: 'POST', cookie, form: { org: '', name: 'ProPR test' } });
    const startPage = await start.text();
    assert.match(start.headers.get('content-security-policy')!, /script-src 'self' 'nonce-/);
    assert.match(startPage, /action="https:\/\/github.com\/settings\/apps\/new\?state=/);
    const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(startPage)![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(manifest.name, 'ProPR test');
    assert.equal(manifest.hook_attributes.url, `${PUBLIC_URL}/webhook`);
    assert.deepEqual(manifest.callback_urls, [`${PUBLIC_URL}/api/auth/github/callback`, `${PUBLIC_URL}/setup/github/admin`]);
    assert.equal(manifest.redirect_url, `${PUBLIC_URL}/setup/github/created`);
    assert.equal(manifest.setup_url, `${PUBLIC_URL}/setup/github/installed`);
    const manifestState = stateIn(startPage);

    // A callback with a state this wizard did not issue is refused before GitHub is called.
    assert.equal((await h.request('/setup/github/created?code=manifest-code&state=forged', { cookie })).status, 400);
    assert.equal(h.calls.length, 0);

    // 2. GitHub returns to the instance; the conversion is stored and the install page opens.
    const created = await h.request(`/setup/github/created?code=manifest-code&state=${manifestState}`, { cookie });
    assert.equal(created.status, 303);
    assert.match(created.headers.get('location')!, /^https:\/\/github.com\/apps\/propr-test\/installations\/new\?state=/);
    const keyPath = h.store.path(GITHUB_APP_KEY_FILE);
    assert.equal(readFileSync(keyPath, 'utf8'), PEM);
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    assert.equal((await h.request(`/setup/github/created?code=manifest-code&state=${manifestState}`, { cookie })).status, 400, 'state is single use');

    // 3. An installation of another App is refused; this App's installation is stored with its repositories.
    const install = await h.request('/setup/github/install', { cookie });
    const otherApp = await h.request(`/setup/github/installed?installation_id=8&setup_action=install&state=${stateIn(install.headers.get('location')!)}`, { cookie });
    assert.equal(otherApp.status, 400);
    assert.match(await otherApp.text(), /different GitHub App/);
    const again = await h.request('/setup/github/install', { cookie });
    const installed = await h.request(`/setup/github/installed?installation_id=7&setup_action=install&state=${stateIn(again.headers.get('location')!)}`, { cookie });
    assert.equal(installed.status, 303);
    assert.match(await (await h.request('/setup', { cookie })).text(), /octo\/repo/);

    // 4. The administrator signs in with the App's OAuth client.
    const signin = await h.request('/setup/github/signin', { cookie });
    const authorize = new URL(signin.headers.get('location')!);
    assert.equal(authorize.origin + authorize.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(authorize.searchParams.get('client_id'), 'Iv1.client');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${PUBLIC_URL}/setup/github/admin`);
    assert.equal((await h.request(`/setup/github/admin?code=oauth-code&state=${authorize.searchParams.get('state')}`, { cookie })).status, 303);

    // 5. Runtime choices are validated before they are saved.
    const badSprites = await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'sprites', spritesToken: 'bad' } });
    assert.equal(badSprites.status, 400);
    const badFly = await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'fly-machines', flyApp: 'propr-test', flyToken: 'x', flyImage: 'registry.fly.io/propr-test:latest' } });
    const badFlyPage = await badFly.text();
    assert.match(badFlyPage, /separate Fly app/);
    assert.match(badFlyPage, /value="fly-machines" checked/, 'the chosen runtime stays selected');
    assert.match(badFlyPage, /id="flyApp"[^>]*value="propr-test"/);
    assert.doesNotMatch(badFlyPage, /id="flyToken"[^>]*value=/, 'tokens are never rendered back');
    const fly = await h.request('/setup/runtime', {
        method: 'POST', cookie,
        form: { runtime: 'fly-machines', flyApp: 'propr-agents', flyToken: 'FlyV1 agent', flyImage: `registry.fly.io/propr-agents@sha256:${'a'.repeat(64)}`, flyMachinesMax: '2' },
    });
    assert.equal(fly.status, 303);
    const sprites = await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'sprites', spritesToken: 'good-sprites' } });
    assert.equal(sprites.status, 303);
    const finishPage = await (await h.request('/setup', { cookie })).text();
    assert.match(finishPage, /Agent runtime: <strong>Sprites/);
    assert.ok(!finishPage.includes('good-sprites'), 'tokens are never echoed');

    // 6. Finish: idle shutdown stays off unless chosen; the wizard completes and closes.
    const done = await h.request('/setup/finish', { method: 'POST', cookie, form: {} });
    assert.equal(done.status, 200);
    const final = await h.completed;
    assert.ok(final.completedAt);
    assert.equal(existsSync(h.store.path(SETUP_ACCESS_FILE)), false);
    assert.equal((await h.request('/setup', { cookie })).status, 503);

    const config = readLaunchConfig(h.store);
    assert.equal(setupRequired(config, {}), false, 'the wizard never starts again');
    assert.equal(config.env.GH_APP_ID, '42');
    assert.equal(config.env.GH_INSTALLATION_ID, '7');
    assert.equal(config.env.GITHUB_REPOS_TO_MONITOR, 'octo/repo,octo/other');
    assert.equal(config.env.PROPR_ADMIN_USERS, 'Octo');
    assert.equal(config.env.PROPR_AGENT_RUNTIME, 'sprites');
    assert.equal(config.env.SPRITES_TOKEN, 'good-sprites');
    assert.equal(config.env.PROPR_FLY_API_TOKEN, undefined, 'the earlier runtime choice is cleared');
    assert.equal(config.env.PROPR_IDLE_SHUTDOWN, undefined);
    assert.equal(statSync(h.store.path('config.json')).mode & 0o777, 0o600);

    const logged = h.logs.join('\n');
    for (const secret of ['hook-secret', 'client-secret', 'good-sprites', 'FlyV1 agent', 'gho_user', 'ghs_installation', h.code]) {
        assert.ok(!logged.includes(secret), `logs must not contain ${secret}`);
    }
});

/** Claim, create and install the App, and sign the administrator in: the wizard is at the runtime step. */
async function throughAdministrator(h: Harness): Promise<string> {
    const cookie = await claim(h);
    const start = await (await h.request('/setup/github/start', { method: 'POST', cookie, form: { org: '' } })).text();
    assert.equal((await h.request(`/setup/github/created?code=manifest-code&state=${stateIn(start)}`, { cookie })).status, 303);
    const install = await h.request('/setup/github/install', { cookie });
    assert.equal((await h.request(`/setup/github/installed?installation_id=7&state=${stateIn(install.headers.get('location')!)}`, { cookie })).status, 303);
    const signin = new URL((await h.request('/setup/github/signin', { cookie })).headers.get('location')!);
    assert.equal((await h.request(`/setup/github/admin?code=oauth-code&state=${signin.searchParams.get('state')}`, { cookie })).status, 303);
    return cookie;
}

/** A Sprites check that holds until released; `started` resolves once a check is waiting. */
function heldSpritesCheck(): { started: Promise<void>; release: () => void; validators: Partial<RuntimeValidators> } {
    let checking!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { checking = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    return { started, release, validators: { sprites: async () => { checking(); await held; } } };
}

/** Whether a fresh TCP connection to the port is refused (the listener is closed). */
function refused(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = connect(port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(false); });
        socket.once('error', error => resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
    });
}

async function eventuallyRefused(port: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await refused(port)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('the wizard still accepts connections after Finish');
}

const pendingMarker = Symbol('pending');
const isPending = async (promise: Promise<unknown>): Promise<boolean> =>
    (await Promise.race([promise, new Promise(resolve => setImmediate(() => resolve(pendingMarker)))])) === pendingMarker;

test('a runtime save still checking when Finish completes is refused with 409 and does not undo the finish', async () => {
    const check = heldSpritesCheck();
    // The real runSetupWizard lifecycle; the grace is far longer than the test may take, so only the drain can end it.
    const h = await startWizard({ run: true, closeGraceMs: 60_000, validators: check.validators });
    const cookie = await throughAdministrator(h);
    assert.equal((await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'none' } })).status, 303);

    // A second runtime choice is still being checked when Finish is sent.
    const pendingSave = h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'sprites', spritesToken: 'late-sprites' } });
    await check.started;
    const done = await h.request('/setup/finish', { method: 'POST', cookie, form: {} });
    assert.equal(done.status, 200);
    assert.equal(done.headers.get('connection'), 'close');
    const finished = readLaunchConfig(h.store);
    assert.ok(finished.completedAt);

    // After Finish no new connection is accepted, but the server waits for the pending check.
    await eventuallyRefused(h.port);
    assert.ok(await isPending(h.completed), 'runSetupWizard waits for the in-flight request');

    const released = Date.now();
    check.release();
    const late = await pendingSave;
    assert.equal(late.status, 409);
    assert.equal(late.headers.get('connection'), 'close');
    assert.match(await late.text(), /Setup already completed/);
    assert.match(h.logs.join('\n'), /its result was not saved/);

    const final = await h.completed;
    assert.ok(Date.now() - released < 5_000, 'the server closes once the last answer is sent, not at the grace deadline');
    assert.deepEqual(final, finished);

    const stored = readLaunchConfig(h.store);
    assert.equal(stored.completedAt, final.completedAt, 'the late save keeps completedAt');
    assert.deepEqual(stored, final, 'nothing of the late save is stored');
    assert.equal(stored.runtime, 'none');
    assert.equal(stored.env.SPRITES_TOKEN, undefined);
    assert.equal(setupRequired(readLaunchConfig(h.store), {}), false, 'the wizard does not start again on restart');
});

test('after Finish a request that never answers is cut at the grace deadline, so shutdown stays bounded', async () => {
    const check = heldSpritesCheck();
    cleanups.push(() => check.release());
    const h = await startWizard({ run: true, closeGraceMs: 300, validators: check.validators });
    assert.ok(SETUP_WIZARD_CLOSE_GRACE_MS <= 10_000, 'the default grace is a few seconds');
    const cookie = await throughAdministrator(h);
    assert.equal((await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'none' } })).status, 303);

    const pendingSave = h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'sprites', spritesToken: 'stuck' } });
    pendingSave.catch(() => undefined);
    await check.started;
    const finishedAt = Date.now();
    assert.equal((await h.request('/setup/finish', { method: 'POST', cookie, form: {} })).status, 200);

    const final = await h.completed;
    const elapsed = Date.now() - finishedAt;
    assert.ok(elapsed >= 250, `closed after ${elapsed}ms, before the grace deadline`);
    assert.ok(elapsed < 5_000, `closed after ${elapsed}ms`);
    await assert.rejects(pendingSave, 'the stuck connection is cut');
    assert.ok(final.completedAt);
    assert.equal(await refused(h.port), true);
});

test('storing manifest credentials: key file 0600, App env for direct webhooks, earlier install and admin cleared', () => {
    const root = mkdtempSync(join(tmpdir(), 'fly-launch-store-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = createLaunchStore(join(root, 'fly-launch'));
    const earlier: LaunchConfig = { version: 1, env: { GH_INSTALLATION_ID: '1', PROPR_ADMIN_USERS: 'old', SPRITES_TOKEN: 'keep' }, admin: { login: 'old', id: 1 } };
    const config = storeManifestCredentials(store, earlier, credentials());
    assert.deepEqual(config.github, { appId: 42, slug: 'propr-test', ownerLogin: 'octo', htmlUrl: 'https://github.com/apps/propr-test' });
    assert.equal(config.admin, undefined);
    assert.deepEqual(config.env, {
        SPRITES_TOKEN: 'keep', GH_APP_ID: '42', GH_WEBHOOK_SECRET: 'hook-secret', GH_OAUTH_CLIENT_ID: 'Iv1.client', GH_OAUTH_CLIENT_SECRET: 'client-secret',
        GH_AUTH_MODE: 'app', GITHUB_EVENT_INTAKE_MODE: 'direct_webhook', PROPR_DEMO_MODE: 'false',
    });
    assert.equal(statSync(store.path(GITHUB_APP_KEY_FILE)).mode & 0o777, 0o600);

    // On boot the stored values fill unset variables; Fly secrets win.
    const env: NodeJS.ProcessEnv = { FLY_APP_NAME: 'propr-test', GH_WEBHOOK_SECRET: 'from-fly' };
    const applied = applyLaunchEnv(env, store, config, { mcp: true, keyExists: existsSync });
    assert.equal(env.GH_APP_ID, '42');
    assert.equal(env.GH_WEBHOOK_SECRET, 'from-fly');
    assert.equal(env.GH_PRIVATE_KEY_PATH, store.path(GITHUB_APP_KEY_FILE));
    assert.deepEqual(applied.overridden, ['GH_WEBHOOK_SECRET']);
    assert.ok(!JSON.stringify(applied).includes('client-secret'));
});

test('an instance configured with Fly secrets (or a propr deploy fly redeploy) never shows the wizard', () => {
    const config: LaunchConfig = { version: 1, env: {} };
    assert.equal(setupRequired(config, {}), true);
    assert.equal(setupRequired(config, { GH_APP_ID: '1' }), false);
    assert.equal(setupRequired(config, { PROPR_GH_RELAY_TOKEN: 'relay' }), false);
    assert.equal(setupRequired(config, { PROPR_DEMO_MODE: 'true' }), false);
});

// ── The ProPR App path (ProPR Connect), the default ──────────────────────────

const CLIENT_ID = 'Ov23liClientIdValue1';
const CLIENT_SECRET = 'c'.repeat(40);

/** Every byte the wizard keeps on the volume. */
function volumeText(store: LaunchStore): string {
    return readdirSync(store.dir).map(name => readFileSync(join(store.dir, name), 'utf8')).join('\n');
}

async function enroll(h: Harness, cookie: string, form: Record<string, string> = {}): Promise<Response> {
    return h.request('/setup/connect/enroll', { method: 'POST', cookie, form: { githubToken: USER_TOKEN, ...form } });
}

/** Enroll, register the sign-in app and sign the administrator in through the API callback the wizard forwards. */
async function connectThroughAdministrator(h: Harness, cookie: string): Promise<void> {
    assert.equal((await enroll(h, cookie)).status, 303);
    assert.equal((await h.request('/setup/connect/signin-app', { method: 'POST', cookie, form: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } })).status, 303);
    const authorize = new URL((await h.request('/setup/github/signin', { cookie })).headers.get('location')!);
    assert.equal(authorize.searchParams.get('client_id'), CLIENT_ID);
    // The OAuth App's one callback is the API's; the wizard forwards it to its own admin route.
    assert.equal(authorize.searchParams.get('redirect_uri'), `${PUBLIC_URL}/api/auth/github/callback`);
    const query = `code=oauth-code&state=${authorize.searchParams.get('state')}`;
    const forwarded = await h.request(`/api/auth/github/callback?${query}`);
    assert.equal(forwarded.status, 303);
    assert.equal(forwarded.headers.get('location'), `/setup/github/admin?${query}`);
    assert.equal((await h.request(forwarded.headers.get('location')!, { cookie })).status, 303);
}

test('the GitHub step offers the ProPR App first (recommended) and your own App as the advanced choice', async () => {
    const h = await startWizard();
    const page = await (await h.request('/setup', { cookie: await claim(h) })).text();
    const connect = page.indexOf('Use the ProPR App');
    const advanced = page.indexOf('Advanced: Create your own GitHub App');
    assert.ok(connect > 0 && advanced > connect, 'the ProPR App comes first');
    assert.match(page, /Recommended/);
    assert.ok(page.includes(`href="${PROPR_APP_INSTALL_URL}"`), 'links the shared App install page');
    assert.match(page, /<details class="path"><summary>Advanced/, 'the own-App form starts collapsed');
    assert.match(page, /action="\/setup\/connect\/enroll"/);
    assert.match(page, /action="\/setup\/github\/start"/, 'the manifest form is still there');
    assert.match(page, /<li class="current" aria-current="step"><span class="dot" aria-hidden="true">2<\/span><span class="label"><span class="sr">2\. <\/span>GitHub</);
    assert.match(page, /<li class="upcoming">.*?3\. <\/span>Sign-in app/);
    assert.equal(h.calls.length, 0, 'nothing is sent anywhere until a path is chosen');
});

test('the ProPR App path end to end: enroll, sign-in app, administrator, runtime, finish with idle wake; restart-safe and the user token is never kept', async () => {
    const h = await startWizard({ run: true });
    const cookie = await claim(h);
    await connectThroughAdministrator(h, cookie);

    // Enrollment: discovery and enrollment with the user token, the label the CLI uses, then one installation token with the relay token.
    assert.deepEqual(h.relay.enrolled, [{ installation_id: 77, label: 'fly:propr-test@machine-1' }]);
    assert.deepEqual(h.relay.auth.slice(0, 3), [`me Bearer ${USER_TOKEN}`, `enroll Bearer ${USER_TOKEN}`, `mint Bearer ${RELAY_TOKEN}`]);
    assert.deepEqual(h.relay.revoked, []);

    assert.equal((await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'none' } })).status, 303);
    const finish = await (await h.request('/setup', { cookie })).text();
    assert.match(finish, /registers the instance's <code>\/wake<\/code> URL with ProPR Connect/);
    assert.equal((await h.request('/setup/finish', { method: 'POST', cookie, form: { idleShutdown: 'on' } })).status, 200);
    const final = await h.completed;

    // Idle shutdown registered this instance's /wake with Connect, with the relay token.
    assert.deepEqual(h.relay.wake, [{ url: `${PUBLIC_URL}/wake` }]);
    assert.equal(h.relay.auth.at(-1), `wake Bearer ${RELAY_TOKEN}`);

    const stored = readLaunchConfig(h.store);
    assert.deepEqual(stored, final);
    assert.deepEqual(stored.connect, { installationId: '77', accountLogin: 'octo', label: 'fly:propr-test@machine-1', tokenId: 'tok-1', tokenPrefix: 'prt_rel', wakeTarget: `${PUBLIC_URL}/wake` });
    assert.equal(stored.github, undefined);
    assert.deepEqual(
        Object.fromEntries(['GH_AUTH_MODE', 'PROPR_GH_RELAY_URL', 'PROPR_GH_RELAY_TOKEN', 'GH_INSTALLATION_ID', 'GITHUB_EVENT_INTAKE_MODE', 'GITHUB_REPOS_TO_MONITOR', 'GH_OAUTH_CLIENT_ID', 'PROPR_ADMIN_USERS', 'PROPR_IDLE_SHUTDOWN'].map(key => [key, stored.env[key]])),
        {
            GH_AUTH_MODE: 'relay', PROPR_GH_RELAY_URL: 'https://webhook.propr.dev/v1', PROPR_GH_RELAY_TOKEN: RELAY_TOKEN, GH_INSTALLATION_ID: '77',
            GITHUB_EVENT_INTAKE_MODE: 'routing_websocket', GITHUB_REPOS_TO_MONITOR: 'octo/repo,octo/other', GH_OAUTH_CLIENT_ID: CLIENT_ID,
            PROPR_ADMIN_USERS: 'Octo', PROPR_IDLE_SHUTDOWN: 'on',
        },
    );
    for (const key of ['GH_APP_ID', 'GH_WEBHOOK_SECRET']) assert.equal(stored.env[key], undefined, `no own-App ${key}`);
    assert.equal(existsSync(h.store.path(GITHUB_APP_KEY_FILE)), false);
    assert.equal(statSync(h.store.path('config.json')).mode & 0o777, 0o600);

    // The user token and everything Connect returns besides the relay token never reach the volume or the logs.
    const volume = volumeText(h.store);
    for (const secret of [USER_TOKEN, 'ghs_relay_installation', 'gho_user', 'pws_generated']) assert.ok(!volume.includes(secret), `the volume must not contain ${secret}`);
    const logged = h.logs.join('\n');
    for (const secret of [USER_TOKEN, RELAY_TOKEN, CLIENT_SECRET, 'ghs_relay_installation', 'gho_user', h.code]) assert.ok(!logged.includes(secret), `logs must not contain ${secret}`);
    assert.match(logged, /labelled fly:propr-test@machine-1/);

    // A restart boots the control plane, not the wizard, in relay mode with no public webhook.
    assert.equal(setupRequired(stored, {}), false);
    const env: NodeJS.ProcessEnv = { FLY_APP_NAME: 'propr-test' };
    applyLaunchEnv(env, h.store, stored, { mcp: true, keyExists: existsSync });
    assert.equal(env.GH_AUTH_MODE, 'relay');
    assert.equal(env.GITHUB_EVENT_INTAKE_MODE, 'routing_websocket');
    assert.equal(env.PROPR_GH_RELAY_TOKEN, RELAY_TOKEN);
    assert.equal(env.GH_PRIVATE_KEY_PATH, undefined);
    assert.equal(env.GH_OAUTH_CALLBACK_URL, `${PUBLIC_URL}/api/auth/github/callback`, 'the sign-in app\'s callback');
});

test('a Fly secret still wins over every value the ProPR App path stored', async () => {
    const h = await startWizard();
    assert.equal((await enroll(h, await claim(h))).status, 303);
    const stored = readLaunchConfig(h.store);
    const env: NodeJS.ProcessEnv = { FLY_APP_NAME: 'propr-test', GITHUB_EVENT_INTAKE_MODE: 'polling', GH_INSTALLATION_ID: '900', PROPR_GH_RELAY_URL: 'https://relay.example/v1' };
    const applied = applyLaunchEnv(env, h.store, stored, { mcp: true, keyExists: existsSync });
    assert.equal(env.GITHUB_EVENT_INTAKE_MODE, 'polling');
    assert.equal(env.GH_INSTALLATION_ID, '900');
    assert.equal(env.PROPR_GH_RELAY_URL, 'https://relay.example/v1');
    assert.equal(env.PROPR_GH_RELAY_TOKEN, RELAY_TOKEN, 'unset values still come from the volume');
    assert.deepEqual(applied.overridden.sort(), ['GH_INSTALLATION_ID', 'GITHUB_EVENT_INTAKE_MODE', 'PROPR_GH_RELAY_URL']);
    assert.ok(!JSON.stringify(applied).includes(RELAY_TOKEN), 'only names are reported');
});

test('a restart mid-setup resumes the ProPR App path where it stopped, with the same claim', async () => {
    const first = await startWizard();
    const cookie = await claim(first);
    assert.equal((await enroll(first, cookie)).status, 303);
    assert.match(await (await first.request('/setup', { cookie })).text(), /Register the sign-in app/);

    // Same volume, new process: no new code is printed, the claim cookie still works, the step is the same.
    const second = await startWizard({ store: first.store });
    assert.equal(createSetupAccess(first.store).issueCode(), null);
    const page = await (await second.request('/setup', { cookie })).text();
    assert.match(page, /Register the sign-in app/);
    assert.ok(page.includes(`${PUBLIC_URL}/api/auth/github/callback`), 'shows the callback URL to register');
    assert.equal(second.relay.enrolled.length, 0, 'nothing is enrolled again');
    assert.equal((await enroll(second, cookie)).status, 303, 'a stale enroll form only returns to the current step');
    assert.equal(second.relay.enrolled.length, 0);

    // Registering the sign-in app, then the administrator, still continues from the stored state after another restart.
    assert.equal((await second.request('/setup/connect/signin-app', { method: 'POST', cookie, form: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } })).status, 303);
    const third = await startWizard({ store: first.store });
    assert.match(await (await third.request('/setup', { cookie })).text(), /Sign in as the administrator/);
    assert.match(await (await third.request('/setup/connect/signin-app', { cookie })).text(), /Register the sign-in app/, 'the sign-in app can be replaced before sign-in');
});

test('more than one installation: the wizard asks which one, keeps no token, and enrolls the one picked', async () => {
    const relay = relayFake({
        installations: [
            { installation_id: 77, account_login: 'octo', account_type: 'User' },
            { installation_id: 78, account_login: 'octo-org', account_type: 'Organization' },
        ],
    });
    const h = await startWizard({ relay });
    const cookie = await claim(h);
    const pick = await enroll(h, cookie);
    assert.equal(pick.status, 200);
    const page = await pick.text();
    assert.match(page, /name="installation" value="77" checked/);
    assert.match(page, /name="installation" value="78"/);
    assert.match(page, /octo-org/);
    assert.match(page, /paste the token again/);
    assert.ok(!page.includes(USER_TOKEN), 'the token is not rendered back');
    assert.deepEqual(relay.enrolled, []);
    assert.equal(existsSync(h.store.path('config.json')), false, 'nothing is stored before enrollment');

    assert.equal((await enroll(h, cookie, { installation: '999' })).status, 400, 'an installation the account cannot use is refused');
    assert.equal((await enroll(h, cookie, { installation: '78' })).status, 303);
    assert.deepEqual(relay.enrolled, [{ installation_id: 78, label: 'fly:propr-test@machine-1' }]);
    assert.equal(readLaunchConfig(h.store).env.GH_INSTALLATION_ID, '78');
});

test('enrollment failures store nothing and say what to do', async () => {
    const cases: Array<{ name: string; relay: RelayFake; form?: Record<string, string>; message: RegExp; revoked?: boolean }> = [
        { name: 'malformed token', relay: relayFake(), form: { githubToken: 'not a token' }, message: /Paste a GitHub token/ },
        { name: 'no installation', relay: relayFake({ installations: [] }), message: /Install the ProPR App first/ },
        { name: 'token GitHub refuses', relay: relayFake({ fail: { me: 401 } }), message: /did not accept that token/ },
        { name: 'not the installation owner', relay: relayFake({ fail: { enroll: 403 } }), message: /Only the owner/ },
        { name: 'relay down', relay: relayFake({ fail: { enroll: 503 } }), message: /answered HTTP 503/ },
        { name: 'new relay token cannot mint', relay: relayFake({ fail: { mint: 500 } }), message: /answered HTTP 500/, revoked: true },
    ];
    for (const entry of cases) {
        const h = await startWizard({ relay: entry.relay });
        const cookie = await claim(h);
        const response = await enroll(h, cookie, entry.form);
        assert.equal(response.status, 400, entry.name);
        const page = await response.text();
        assert.match(page, entry.message, entry.name);
        assert.match(page, /Use the ProPR App/, `${entry.name}: the GitHub step is shown again`);
        assert.ok(!page.includes(USER_TOKEN), `${entry.name}: the token is not rendered back`);
        assert.equal(readLaunchConfig(h.store).connect, undefined, `${entry.name}: nothing stored`);
        assert.deepEqual(entry.relay.revoked, entry.revoked ? [{ installation_id: 77, token_id: 'tok-1' }] : [], `${entry.name}: revoke`);
        assert.ok(!h.logs.join('\n').includes(USER_TOKEN));
    }
});

test('an enrollment still running when the own App is stored is refused under the write lock, and its relay token revoked', async () => {
    let release!: () => void;
    let started!: () => void;
    const enrolling = new Promise<void>(resolve => { started = resolve; });
    const relay = relayFake({ holdEnroll: new Promise<void>(resolve => { release = resolve; }), enrollStarted: () => started() });
    const h = await startWizard({ relay });
    const cookie = await claim(h);

    const pending = enroll(h, cookie);
    await enrolling;
    // Meanwhile the same browser finishes the advanced path's manifest flow.
    const start = await (await h.request('/setup/github/start', { method: 'POST', cookie, form: { org: '' } })).text();
    assert.equal((await h.request(`/setup/github/created?code=manifest-code&state=${stateIn(start)}`, { cookie })).status, 303);
    const withApp = readLaunchConfig(h.store);
    release();

    const late = await pending;
    assert.equal(late.status, 400);
    assert.match(await late.text(), /Another setup step finished/);
    assert.deepEqual(relay.revoked, [{ installation_id: 77, token_id: 'tok-1' }], 'the relay token issued for the refused result is revoked');
    const stored = readLaunchConfig(h.store);
    assert.deepEqual(stored, withApp, 'the own App stays as stored');
    assert.equal(stored.env.PROPR_GH_RELAY_TOKEN, undefined);
    assert.equal(existsSync(h.store.path(GITHUB_APP_KEY_FILE)), true);
    assert.deepEqual(readdirSync(h.store.dir).filter(name => name.endsWith('.tmp')), [], 'every write was a complete rename');
});

test('idle shutdown on the ProPR App path needs the wake URL registered: a failure keeps the wizard open', async () => {
    const relay = relayFake({ fail: { wake: 500 } });
    const h = await startWizard({ relay });
    const cookie = await claim(h);
    await connectThroughAdministrator(h, cookie);
    assert.equal((await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'none' } })).status, 303);

    const refusedFinish = await h.request('/setup/finish', { method: 'POST', cookie, form: { idleShutdown: 'on' } });
    assert.equal(refusedFinish.status, 400);
    assert.match(await refusedFinish.text(), /could not register this instance&#39;s wake URL/);
    assert.equal(readLaunchConfig(h.store).completedAt, undefined);
    assert.ok(await isPending(h.completed));

    // Without idle shutdown nothing is registered and setup finishes.
    assert.equal((await h.request('/setup/finish', { method: 'POST', cookie, form: {} })).status, 200);
    const final = await h.completed;
    assert.equal(final.env.PROPR_IDLE_SHUTDOWN, undefined);
    assert.equal(final.connect?.wakeTarget, undefined);
    assert.equal(relay.auth.filter(entry => entry.startsWith('wake ')).length, 1, 'only the failed attempt');
});

test('the sign-in app form refuses malformed credentials and a new one clears an earlier administrator', async () => {
    const h = await startWizard();
    const cookie = await claim(h);
    await connectThroughAdministrator(h, cookie);
    const bad = await h.request('/setup/connect/signin-app', { method: 'POST', cookie, form: { clientId: 'x', clientSecret: 'y' } });
    assert.equal(bad.status, 303, 'past the admin step the form only returns to the current step');
    assert.equal(readLaunchConfig(h.store).env.PROPR_ADMIN_USERS, 'Octo');

    const h2 = await startWizard();
    const cookie2 = await claim(h2);
    assert.equal((await enroll(h2, cookie2)).status, 303);
    const malformed = await h2.request('/setup/connect/signin-app', { method: 'POST', cookie: cookie2, form: { clientId: CLIENT_ID, clientSecret: 'short' } });
    assert.equal(malformed.status, 400);
    const page = await malformed.text();
    assert.match(page, /client secret/);
    assert.ok(!page.includes('short'), 'the secret is not rendered back');
    assert.equal(readLaunchConfig(h2.store).env.GH_OAUTH_CLIENT_ID, undefined);
});

test('the two paths never mix: storing one clears the other, including the App key file', () => {
    const root = mkdtempSync(join(tmpdir(), 'fly-launch-paths-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = createLaunchStore(join(root, 'fly-launch'));
    const withApp = storeManifestCredentials(store, { version: 1, env: { SPRITES_TOKEN: 'keep' } }, credentials());
    const enrollment: ConnectEnrollment = {
        relayUrl: 'https://webhook.propr.dev/v1', relayToken: RELAY_TOKEN, repositories: [], installationId: '77',
        accountLogin: 'octo', label: 'fly:a@b', tokenId: 'tok-1', tokenPrefix: 'prt_rel',
    };
    const connected = storeConnectEnrollment(store, withApp, enrollment);
    assert.equal(existsSync(store.path(GITHUB_APP_KEY_FILE)), false);
    assert.equal(connected.github, undefined);
    for (const key of ['GH_APP_ID', 'GH_WEBHOOK_SECRET', 'GH_OAUTH_CLIENT_ID', 'GH_OAUTH_CLIENT_SECRET', 'GITHUB_REPOS_TO_MONITOR']) assert.equal(connected.env[key], undefined, key);
    assert.equal(connected.env.SPRITES_TOKEN, 'keep');
    assert.equal(connected.env.GH_AUTH_MODE, 'relay');

    const back = storeManifestCredentials(store, connected, credentials());
    assert.equal(back.connect, undefined);
    assert.equal(back.env.PROPR_GH_RELAY_TOKEN, undefined);
    assert.equal(back.env.PROPR_GH_RELAY_URL, undefined);
    assert.equal(back.env.GH_AUTH_MODE, 'app');
    assert.equal(back.env.GITHUB_EVENT_INTAKE_MODE, 'direct_webhook');
});

/** Every link that leaves the wizard opens in a new tab; every submit button names its busy label. */
function assertPageConventions(page: string, name: string): void {
    for (const [tag, href] of page.matchAll(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>/g)) {
        assert.match(tag, /target="_blank" rel="noopener noreferrer"/, `${name}: ${href} opens in a new tab`);
    }
    for (const [button] of page.matchAll(/<button type="submit"[^>]*>/g)) assert.match(button, /data-busy="[^"]+…"/, `${name}: ${button} has a busy label`);
    assert.match(page, /<script src="\/setup\/assets\/wizard.js" defer><\/script>/, `${name}: loads the busy-state script`);
}

test('branding: ProPR logo and favicon served by the wizard itself, "on Fly.io" linking the app, progress steps', async () => {
    const h = await startWizard();
    const claimPage = await (await h.request('/setup')).text();
    assert.match(claimPage, /<img src="\/setup\/assets\/logo.png" alt="ProPR"/);
    assert.match(claimPage, /<link rel="icon" type="image\/png" href="\/setup\/assets\/favicon.png">/);
    assert.match(claimPage, /class="on-fly">on <a href="https:\/\/fly.io\/apps\/propr-test" target="_blank"[^>]*>Fly.io<.*<span class="host">propr-test.fly.dev<\/span>/);
    assert.match(claimPage, /<li class="current" aria-current="step">.*1\. <\/span>Setup code<span class="sr"> \(current\)/);
    assertPageConventions(claimPage, 'claim');

    // Assets need no claim: they hold nothing about the instance.
    const favicon = await h.request('/setup/assets/favicon.png');
    assert.equal(favicon.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await favicon.arrayBuffer()), readFileSync(join(import.meta.dirname, '../propr-ui/public/logo.png')), 'the Web UI favicon, byte for byte');
    const logo = Buffer.from(await (await h.request('/setup/assets/logo.png')).arrayBuffer());
    assert.equal(logo.subarray(1, 4).toString(), 'PNG');
    assert.deepEqual([logo.readUInt32BE(16), logo.readUInt32BE(20)], [208, 64], 'the logo, at twice its 32px display height');
    const script = await h.request('/setup/assets/wizard.js');
    assert.match(script.headers.get('content-type')!, /^text\/javascript/);
    assert.equal(await script.text(), WIZARD_SCRIPT);
    assert.doesNotThrow(() => new Function(WIZARD_SCRIPT), 'the script parses');

    const cookie = await claim(h);
    const github = await h.request('/setup', { cookie });
    assert.match(github.headers.get('content-security-policy')!, /img-src 'self'; script-src 'self'; /);
    const githubPage = await github.text();
    assertPageConventions(githubPage, 'github');
    assert.match(githubPage, /<li class="done"><span class="dot" aria-hidden="true">✓<\/span><span class="label"><span class="sr">1\. <\/span>Setup code<span class="sr"> \(done\)/);
});

test('agent runtime: Sprites token page and scope with the exact prefix; Fly Machines prefilled; one form at a time', async () => {
    const h = await startWizard({ countMachines: async () => 1 });
    const cookie = await throughAdministrator(h);
    const page = await (await h.request('/setup', { cookie })).text();
    assertPageConventions(page, 'runtime');
    const prefix = spritesNamePrefix('propr-test', h.options.dataDir!);
    assert.ok(page.includes(`href="${SPRITES_TOKENS_URL}" target="_blank"`), 'links the Sprites tokens page in a new tab');
    assert.match(page, /switch org there/);
    assert.ok(page.includes(`<li>Name prefix: <code>${prefix}</code></li><li>Max Sprites: 1 on the Free Plan.</li><li>Expiry: optional.</li>`));
    assert.match(page, /name="runtime" value="sprites" checked/, 'Sprites is the default');
    // Fly Machines: everything prefilled, the build-your-own image behind Advanced.
    assert.match(page, /id="flyApp"[^>]*value="propr-test-agents"/);
    assert.equal(DEFAULT_AGENT_IMAGE, `propr/agent:${PROPR_VERSION}`);
    assert.ok(page.includes(`id="flyImage" name="flyImage" type="text" autocomplete="off" spellcheck="false" placeholder="${DEFAULT_AGENT_IMAGE}" value="${DEFAULT_AGENT_IMAGE}"`));
    assert.match(page, /id="flyMachinesMax"[^>]*value="2"/, '3 minus this app\'s one Machine');
    assert.ok(page.includes('<pre>fly apps create <span data-agent-app>propr-test-agents</span> &amp;&amp; fly tokens create deploy --app <span data-agent-app>propr-test-agents</span> --expiry 8760h</pre>'));
    assert.match(page, /href="https:\/\/fly.io\/dashboard\/personal" target="_blank"/);
    assert.match(page, /<details class="advanced"><summary>Advanced: build your own agent image<\/summary>[^]*Dockerfile.agent/);
    assert.match(page, /\.option:not\(:has\(input\[name=runtime\]:checked\)\) \.panel\{display:none\}/, 'unchosen options are collapsed');
    // Hints are one sentence; longer explanations sit behind "Why?".
    for (const [, hint] of page.matchAll(/<p class="hint">(.*?)<\/p>/g)) {
        assert.ok(hint.replace(/<[^>]+>/g, '').split(/[.!?](?:\s|$)/).filter(part => part.trim()).length <= 1, `one sentence: ${hint}`);
    }
    assert.ok((page.match(/<details class="why">/g) ?? []).length >= 2);
});

test('agent runtime: the defaults save as shown, and the next step shows what the check found', async () => {
    const seen: Array<string | undefined> = [];
    const h = await startWizard({
        countMachines: async () => 2,
        validators: {
            sprites: async (token, prefix) => { seen.push(prefix); if (token !== 'good-sprites') throw new Error('401'); return { organization: 'personal', running: 1, runningLimit: 3 }; },
            flyMachineCount: async () => 0,
        },
    });
    const cookie = await throughAdministrator(h);
    assert.match(await (await h.request('/setup', { cookie })).text(), /id="flyMachinesMax"[^>]*value="1"/, '3 minus this app\'s two Machines');
    // Fly Machines with the prefilled image (left as shown) and the computed default.
    const fly = await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'fly-machines', flyApp: 'propr-agents', flyToken: 'FlyV1 agent', flyImage: DEFAULT_AGENT_IMAGE, flyMachinesMax: '1' } });
    assert.equal(fly.status, 303);
    let finish = await (await h.request('/setup', { cookie })).text();
    assert.match(finish, /<p class="notice" role="status"><strong>✓ Checked:<\/strong> Token works · agent app propr-agents · 0 Machines in it now · up to 1 agent Machine at once<\/p>/);
    assert.equal(readLaunchConfig(h.store).env.PROPR_FLY_IMAGE, DEFAULT_AGENT_IMAGE);
    assertPageConventions(finish, 'finish');
    // Sprites: listed under this instance's prefix; the summary replaces the earlier one.
    assert.equal((await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'sprites', spritesToken: 'good-sprites' } })).status, 303);
    assert.deepEqual(seen, [spritesNamePrefix('propr-test', h.options.dataDir!)]);
    finish = await (await h.request('/setup', { cookie })).text();
    assert.match(finish, /✓ Checked:<\/strong> Token works · organization personal · 2 of 3 Sprites free<\/p>/);
    assert.ok(!finish.includes('good-sprites'));
    // "Not yet" checks nothing, so it claims nothing.
    assert.equal((await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'none' } })).status, 303);
    assert.doesNotMatch(await (await h.request('/setup', { cookie })).text(), /class="notice"/);
    assert.equal(readLaunchConfig(h.store).runtimeCheck, undefined);
});

test('a failed check re-renders the step with an inline error and a fresh button', async () => {
    const h = await startWizard();
    const cookie = await throughAdministrator(h);
    const failed = await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'sprites', spritesToken: 'bad' } });
    assert.equal(failed.status, 400);
    const page = await failed.text();
    assert.match(page, /<p class="error" role="alert">That Sprites token could not list Sprites/);
    assert.match(page, /<button type="submit" data-busy="Checking…">Check and save<\/button>/);
    assert.doesNotMatch(page, /class="notice"/);
});
