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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { storeManifestCredentials, type ManifestCredentials } from '../src/flyLaunch/githubSetup.ts';
import { applyLaunchEnv, GITHUB_APP_KEY_FILE, readLaunchConfig, setupRequired, type LaunchConfig } from '../src/flyLaunch/launchConfig.ts';
import { createLaunchStore, type LaunchStore } from '../src/flyLaunch/launchStore.ts';
import { createSetupAccess, SETUP_ACCESS_FILE, SETUP_CLAIM_COOKIE } from '../src/flyLaunch/setupAccess.ts';
import { createSetupWizard, type SetupWizard } from '../src/flyLaunch/setupWizard.ts';
import type { RuntimeValidators } from '../src/flyLaunch/runtimeValidation.ts';

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

function fakeGithub(calls: string[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const key = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
        calls.push(key);
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
    wizard: SetupWizard;
    calls: string[];
    logs: string[];
    code: string;
    request(path: string, options?: { method?: string; form?: Record<string, string>; cookie?: string; origin?: string }): Promise<Response>;
}

async function startWizard(overrides: { validators?: Partial<RuntimeValidators> } = {}): Promise<Harness> {
    const root = mkdtempSync(join(tmpdir(), 'fly-launch-wizard-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = createLaunchStore(join(root, 'fly-launch'));
    const access = createSetupAccess(store);
    const code = access.issueCode()!;
    const calls: string[] = [];
    const logs: string[] = [];
    const wizard = createSetupWizard({
        store, access, publicUrl: PUBLIC_URL, controlPlaneApp: 'propr-test', fetcher: fakeGithub(calls), log: message => logs.push(message),
        validators: {
            sprites: async token => { if (token !== 'good-sprites') throw new Error('401'); },
            flyApp: async (app, token) => (app === 'propr-agents' && token === 'FlyV1 agent' ? 200 : 403),
            ...overrides.validators,
        },
    });
    const server: Server = createServer((req, res) => { void wizard.handle(req, res); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return {
        store, wizard, calls, logs, code,
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
    assert.match(await (await h.request('/setup', { cookie })).text(), /Create the GitHub App/);
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
    assert.match(start.headers.get('content-security-policy')!, /script-src 'nonce-/);
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
    const final = await h.wizard.completed;
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

test('a runtime save still checking when Finish completes is refused with 409 and does not undo the finish', async () => {
    let checking!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { checking = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const h = await startWizard({ validators: { sprites: async () => { checking(); await held; } } });
    const cookie = await throughAdministrator(h);
    assert.equal((await h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'none' } })).status, 303);

    // A second runtime choice is still being checked when Finish is sent.
    const pendingSave = h.request('/setup/runtime', { method: 'POST', cookie, form: { runtime: 'sprites', spritesToken: 'late-sprites' } });
    await started;
    const done = await h.request('/setup/finish', { method: 'POST', cookie, form: {} });
    assert.equal(done.status, 200);
    const final = await h.wizard.completed;
    assert.ok(final.completedAt);

    release();
    const late = await pendingSave;
    assert.equal(late.status, 409);
    assert.match(await late.text(), /Setup already completed/);
    assert.match(h.logs.join('\n'), /its result was not saved/);

    const stored = readLaunchConfig(h.store);
    assert.equal(stored.completedAt, final.completedAt, 'the late save keeps completedAt');
    assert.deepEqual(stored, final, 'nothing of the late save is stored');
    assert.equal(stored.runtime, 'none');
    assert.equal(stored.env.SPRITES_TOKEN, undefined);
    assert.equal(setupRequired(readLaunchConfig(h.store), {}), false, 'the wizard does not start again on restart');
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
