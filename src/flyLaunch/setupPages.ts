/**
 * Server-rendered pages of the Fly dashboard launch setup wizard (#3827).
 * Plain HTML forms in the ProPR look (setupLayout.ts): the wizard runs before
 * the API and the Web UI start, so it serves its own few assets. Every page
 * works without JavaScript; the script only adds busy states and copy buttons.
 * Every link that leaves the wizard opens in a new tab; only the GitHub flows
 * that return to the wizard (manifest, install, sign-in) navigate this tab.
 * Each submit button names its busy label in data-busy.
 *
 * Pages never contain stored secrets; token fields are always rendered empty.
 */
import type { RelayInstallation } from './connectSetup.js';
import { GITHUB_OAUTH_APP_SETTINGS_URL, GITHUB_TOKEN_SETTINGS_URL, OAUTH_CALLBACK_PATH, PROPR_APP_INSTALL_URL } from './connectSetup.js';
import { escapeHtml, externalLink, renderPage, why, type GithubPath, type InstanceInfo } from './setupLayout.js';

export type { GithubPath, InstanceInfo, SetupStep } from './setupLayout.js';
export { CONNECT_SETUP_STEPS, escapeHtml, SETUP_STEPS } from './setupLayout.js';
export { runtimePage, type RuntimeFormValues, type RuntimePageContext } from './setupRuntimePage.js';

export function claimPage(instance: InstanceInfo, error?: string): string {
    return renderPage(instance, {
        title: 'Enter the setup code',
        step: 'claim',
        error,
        body: `<p>Enter the one-time code from this Machine's logs to prove the instance is yours.</p>
<form method="post" action="/setup/claim"><label for="code">Setup code</label>
<input id="code" class="code" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" required placeholder="XXXX-XXXX-XXXX">
<p class="hint">Find it in the dashboard's ${instance.app ? externalLink(`https://fly.io/apps/${encodeURIComponent(instance.app)}/monitoring`, 'Live Logs') : '<strong>Live Logs</strong>'} (or <code>fly logs</code>) after <code>ProPR setup code</code>.</p>
${why('The first browser to enter the code claims the instance, and no other browser can set it up. A restart before then prints a new code.')}
<button type="submit" data-busy="Checking…">Claim this instance</button></form>`,
    });
}

export function claimedElsewherePage(instance: InstanceInfo): string {
    return renderPage(instance, {
        title: 'Setup is in progress',
        body: `<p>Someone already claimed this instance with its setup code and is setting it up from another browser.</p>
<p class="hint">If that was you and you lost the browser session, run <code>fly ssh console -C "rm /usr/src/app/data/fly-launch/setup.json"</code>, restart the Machine and use the new code from the logs. Everything already saved is kept.</p>`,
    });
}

/** The own-App manifest form. */
function manifestForm(publicUrl: string): string {
    return `<p>GitHub creates an App you own from a manifest with this instance's URLs filled in.</p>
${why(`ProPR then reads issues and opens pull requests as that App, with no ProPR-hosted service in the path. Webhook: <code>${escapeHtml(publicUrl)}/webhook</code>; sign-in callback: <code>${escapeHtml(publicUrl)}/api/auth/github/callback</code>.`, 'What does it set up?')}
<form method="post" action="/setup/github/start">
<label for="org">Organization (optional)</label><input id="org" name="org" type="text" autocomplete="off" spellcheck="false" placeholder="Leave empty for your personal account">
<p class="hint">An organization you administer, or empty for your personal account.</p>
<label for="name">App name (optional)</label><input id="name" name="name" type="text" autocomplete="off" maxlength="34" placeholder="ProPR-${escapeHtml(new URL(publicUrl).hostname.split('.')[0])}">
<p class="hint">Unique across GitHub; if it is taken, change it on GitHub.</p>
<button type="submit" data-busy="Opening GitHub…">Continue to GitHub</button></form>`;
}

function installationPicker(installations: RelayInstallation[]): string {
    if (!installations.length) return '';
    return `<fieldset class="runtimes"><legend>Installation</legend>${installations.map((entry, i) =>
        `<label class="choice"><input type="radio" name="installation" value="${escapeHtml(entry.installationId)}"${i === 0 ? ' checked' : ''}> ${escapeHtml(entry.accountLogin || `installation ${entry.installationId}`)}${entry.accountType ? ` <span class="hint">(${escapeHtml(entry.accountType)})</span>` : ''}</label>`).join('')}
<p class="hint">The ProPR App is installed on more than one account you can use. Pick one, then paste the token again: it was not kept.</p></fieldset>`;
}

export interface GithubPageOptions {
    /** An error from the ProPR App form. */
    connectError?: string;
    /** An error from the own-App form; opens that section. */
    ownAppError?: string;
    /** Installations to pick from, after a token that can use more than one. */
    installations?: RelayInstallation[];
}

/** The GitHub step: the ProPR App (recommended, default) or your own App (advanced). */
export function githubPage(instance: InstanceInfo, publicUrl: string, options: GithubPageOptions = {}): string {
    const { connectError, ownAppError, installations = [] } = options;
    return renderPage(instance, {
        title: 'Connect GitHub',
        step: 'github',
        body: `<section class="path" aria-labelledby="connect-title"><h3 id="connect-title">Use the ProPR App <span class="badge">Recommended</span></h3>
<p class="hint">GitHub events reach this instance through ProPR Connect, as with <code>propr deploy fly</code>.</p>
${why('The shared ProPR App delivers events over Connect, so this instance needs no public webhook and no GitHub App of your own.')}
${connectError ? `<p class="error" role="alert">${escapeHtml(connectError)}</p>` : ''}<ol class="todo">
<li><strong>Install the ProPR App</strong> on the repositories ProPR should work on.<br>${externalLink(PROPR_APP_INSTALL_URL, 'Install the ProPR App on GitHub', 'secondary')}</li>
<li><strong>Create a GitHub token</strong> with no permissions and the shortest expiry: ${externalLink(GITHUB_TOKEN_SETTINGS_URL, 'new fine-grained token')}.</li></ol>
<form method="post" action="/setup/connect/enroll">${installationPicker(installations)}
<label for="githubToken">GitHub token</label><input id="githubToken" name="githubToken" type="password" autocomplete="off" spellcheck="false" required placeholder="github_pat_…">
<p class="hint">Used once to enroll this instance, then discarded; never stored or logged.</p>
${why('ProPR Connect only reads who you are, to check that you can use the App\'s installation and to issue this instance\'s relay token. You can delete the token on GitHub right after.')}
<button type="submit" data-busy="Connecting…">Connect this instance</button></form></section>
<details class="path"${ownAppError ? ' open' : ''}><summary>Advanced: Create your own GitHub App</summary>
${ownAppError ? `<p class="error" role="alert">${escapeHtml(ownAppError)}</p>` : ''}${manifestForm(publicUrl)}</details>`,
    });
}

export function manifestRedirectPage(instance: InstanceInfo, action: string, manifest: unknown, nonce: string): string {
    return renderPage(instance, {
        title: 'Opening GitHub…',
        step: 'github',
        path: 'own-app',
        nonce,
        script: `document.getElementById('manifest-form').submit()`,
        body: `<form id="manifest-form" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<p>Review the App on GitHub and select <strong>Create GitHub App</strong>.</p><button type="submit" data-busy="Opening GitHub…">Continue to GitHub</button></form>`,
    });
}

export function installPage(instance: InstanceInfo, slug: string, error?: string): string {
    return renderPage(instance, {
        title: 'Install the GitHub App',
        step: 'install',
        path: 'own-app',
        error,
        notice: error ? undefined : `GitHub App ${slug} created · credentials stored on the volume`,
        body: `<p>Install it on the repositories ProPR should work on.</p>
<p class="hint">Choose <strong>Only select repositories</strong> to limit what agents can reach.</p>
<a class="button" href="/setup/github/install" data-busy="Opening GitHub…">Install on GitHub</a>`,
    });
}

/** The ProPR App path: register the GitHub OAuth App browsers sign in with. */
export function signInAppPage(instance: InstanceInfo, publicUrl: string, accountLogin: string, error?: string): string {
    const callback = `${publicUrl}${OAUTH_CALLBACK_PATH}`;
    return renderPage(instance, {
        title: 'Register the sign-in app',
        step: 'signin-app',
        error,
        notice: error ? undefined : `Connected to the ProPR App${accountLogin ? ` on ${accountLogin}` : ''} · relay token enrolled`,
        body: `<p>Browsers sign in to this instance with a GitHub OAuth App of your own.</p>
${why('ProPR Connect signs browsers in only through a hosted tunnel. The OAuth App only identifies who signs in; it gets no access to repositories.')}
<ol class="todo"><li>${externalLink(GITHUB_OAUTH_APP_SETTINGS_URL, 'Register a new OAuth App on GitHub')} with:
<ul><li>Homepage URL: <code>${escapeHtml(publicUrl)}</code></li><li>Authorization callback URL: <code>${escapeHtml(callback)}</code></li></ul></li>
<li>Copy its <strong>Client ID</strong>, then <strong>Generate a new client secret</strong> and copy that too.</li></ol>
<form method="post" action="/setup/connect/signin-app">
<label for="clientId">Client ID</label><input id="clientId" name="clientId" type="text" autocomplete="off" spellcheck="false" required>
<label for="clientSecret">Client secret</label><input id="clientSecret" name="clientSecret" type="password" autocomplete="off" required>
<p class="hint">Stored on this instance's volume; a Fly secret <code>GH_OAUTH_CLIENT_ID</code> or <code>GH_OAUTH_CLIENT_SECRET</code> wins.</p>
<button type="submit" data-busy="Saving…">Save and continue</button></form>`,
    });
}

export function adminPage(instance: InstanceInfo, repositories: string[], error?: string, path: GithubPath = 'own-app'): string {
    const app = path === 'connect' ? 'ProPR App' : 'App';
    const found = repositories.length
        ? `${app} installed on ${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}: ${repositories.slice(0, 8).join(', ')}${repositories.length > 8 ? ', …' : ''}`
        : `${app} installed`;
    return renderPage(instance, {
        title: 'Sign in as the administrator',
        step: 'admin',
        path,
        error,
        notice: error ? undefined : found,
        body: `<p>Sign in with GitHub: your account becomes this instance's first administrator.</p>
<p class="hint">You can add others later in Settings → Access.</p>
<a class="button" href="/setup/github/signin" data-busy="Opening GitHub…">Sign in with GitHub</a>${path === 'connect' ? '<p class="hint"><a href="/setup/connect/signin-app">Use a different sign-in app</a> if GitHub refuses this one.</p>' : ''}`,
    });
}

const IDLE_WHY: Record<GithubPath, string> = {
    'own-app': 'The Machine stops itself after 15 minutes without work, and any request (the UI, a GitHub webhook) starts it again in 10–20 seconds. Polling keeps it awake.',
    connect: 'This registers the instance\'s <code>/wake</code> URL with ProPR Connect. While the Machine is stopped, Connect keeps GitHub events for it (on the free tier the newest 25, for one hour), wakes it through <code>/wake</code> and replays them once it reconnects; a request to the UI also starts it. The Machine stops only after Connect has acknowledged the wake hint.',
};

/** `checked`: what the runtime check found, shown as the step's notice. */
export function finishPage(instance: InstanceInfo, runtime: string, error?: string, options: { path?: GithubPath; checked?: string } = {}): string {
    const { path = 'own-app', checked } = options;
    return renderPage(instance, {
        title: 'Start ProPR',
        step: 'finish',
        path,
        error,
        notice: error ? undefined : checked,
        body: `<p>Agent runtime: <strong>${escapeHtml(runtime)}</strong>. Everything is saved on the volume and survives restarts and idle stops.</p>
<form method="post" action="/setup/finish">
<label class="choice"><input type="checkbox" name="idleShutdown" value="on"> Stop the Machine when idle (after 15 minutes without work)</label>
<p class="hint">Off by default; a request starts the Machine again.</p>
${why(IDLE_WHY[path])}
<button type="submit" data-busy="Starting…">Finish setup and start ProPR</button></form>
<p class="hint">Next, sign in and add a model provider in Settings → Agents, as on any ProPR instance.</p>`,
    });
}

export function startingPage(instance: InstanceInfo): string {
    return renderPage(instance, {
        title: 'ProPR is starting',
        refreshSeconds: 20,
        body: `<p><span class="spinner" aria-hidden="true" style="display:inline-block;vertical-align:-2px;margin-right:8px;color:var(--primary)"></span>Setup is complete and this page closes for good. ProPR is starting; this page opens the dashboard in about 20 seconds.</p>
<p>Then sign in with GitHub and add a model provider in <strong>Settings → Agents</strong>. Label an issue <code>AI</code> to get a pull request.</p>`,
    });
}

/** A setup step that finished after Finish: nothing of it was saved. */
export function setupCompletedPage(instance: InstanceInfo): string {
    return renderPage(instance, {
        title: 'Setup already completed',
        refreshSeconds: 20,
        body: `<p>Setup was finished while this step was still running, so its result was not saved. The settings chosen before Finish are kept.</p>
<p>To change a stored value now, set a Fly secret with the same name (or use the dashboard's Secrets page); it wins on the next boot.</p>`,
    });
}
