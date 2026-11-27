/**
 * Server-rendered pages of the Fly dashboard launch setup wizard (#3827).
 * Plain HTML with inline styles: the wizard runs before the API and the Web
 * UI start, and must work without any other asset. The only script is the
 * nonce'd auto-submit of the GitHub App manifest form.
 *
 * Pages never contain stored secrets; token fields are always rendered empty.
 */
export type SetupStep = 'claim' | 'github' | 'install' | 'admin' | 'runtime' | 'finish';

export const SETUP_STEPS: ReadonlyArray<{ id: SetupStep; label: string }> = [
    { id: 'claim', label: 'Setup code' },
    { id: 'github', label: 'GitHub App' },
    { id: 'install', label: 'Install' },
    { id: 'admin', label: 'Administrator' },
    { id: 'runtime', label: 'Agent runtime' },
    { id: 'finish', label: 'Start' },
];

export const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1b1f24;--muted:#5b6470;--line:#d9dde3;--accent:#4f46e5;--accent-text:#fff;--error:#b42318;--error-bg:#fef3f2;--ok:#067647}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#e6e8eb;--muted:#9aa3ae;--line:#2a2f38;--accent:#818cf8;--accent-text:#0f1115;--error:#fda29b;--error-bg:#3a1714;--ok:#75e0a7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 20px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}
.sub{color:var(--muted);margin:0 0 24px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
ol.steps{display:flex;flex-wrap:wrap;gap:6px 14px;list-style:none;padding:0;margin:0 0 20px;font-size:13px;color:var(--muted)}
ol.steps li.done{color:var(--ok)}ol.steps li.current{color:var(--text);font-weight:600}
label{display:block;font-weight:600;margin:16px 0 6px}input[type=text],input[type=password]{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
.code{font:600 20px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}
.hint{color:var(--muted);font-size:13px;margin:6px 0 0}button,.button{display:inline-block;margin-top:20px;padding:10px 18px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-text);font:600 15px/1.2 inherit;text-decoration:none;cursor:pointer}
.error{background:var(--error-bg);color:var(--error);border-radius:8px;padding:10px 12px;margin:0 0 16px}
fieldset{border:1px solid var(--line);border-radius:10px;margin:12px 0;padding:4px 14px 14px}legend{padding:0 6px}
.choice{display:flex;gap:8px;align-items:baseline;font-weight:600;margin:12px 0 0}.choice input{margin:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}ul{padding-left:20px}`;

export interface PageOptions {
    title: string;
    step?: SetupStep;
    error?: string;
    body: string;
    nonce?: string;
    script?: string;
    refreshSeconds?: number;
}

function stepList(current: SetupStep | undefined): string {
    if (!current) return '';
    const index = SETUP_STEPS.findIndex(step => step.id === current);
    return `<ol class="steps" aria-label="Setup steps">${SETUP_STEPS.map((step, i) =>
        `<li class="${i < index ? 'done' : i === index ? 'current' : ''}"${i === index ? ' aria-current="step"' : ''}>${i + 1}. ${step.label}</li>`).join('')}</ol>`;
}

export function renderPage(options: PageOptions): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">${options.refreshSeconds ? `<meta http-equiv="refresh" content="${options.refreshSeconds};url=/">` : ''}
<title>${escapeHtml(options.title)} · ProPR setup</title><style>${STYLE}</style></head>
<body><main><h1>Set up ProPR</h1><p class="sub">First-visit setup for this Fly instance.</p>${stepList(options.step)}
<section class="card"><h2>${escapeHtml(options.title)}</h2>${options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ''}${options.body}</section>
</main>${options.script && options.nonce ? `<script nonce="${options.nonce}">${options.script}</script>` : ''}</body></html>`;
}

export function claimPage(error?: string): string {
    return renderPage({
        title: 'Enter the setup code',
        step: 'claim',
        error,
        body: `<p>This instance is not set up yet. To prove it is yours, enter the one-time setup code from the Machine's logs: run <code>fly logs</code>, or open the app's <strong>Live Logs</strong> in the Fly dashboard, and look for <code>ProPR setup code</code>.</p>
<form method="post" action="/setup/claim"><label for="code">Setup code</label>
<input id="code" class="code" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" required placeholder="XXXX-XXXX-XXXX">
<p class="hint">The first browser to enter it claims the instance. A restart before that prints a new code.</p><button type="submit">Claim this instance</button></form>`,
    });
}

export function claimedElsewherePage(): string {
    return renderPage({
        title: 'Setup is in progress',
        body: `<p>Someone already claimed this instance with its setup code and is setting it up from another browser.</p>
<p class="hint">If that was you and you lost the browser session, run <code>fly ssh console -C "rm /usr/src/app/data/fly-launch/setup.json"</code>, restart the Machine and use the new code from the logs. Everything already saved is kept.</p>`,
    });
}

export function githubAppPage(publicUrl: string, error?: string): string {
    return renderPage({
        title: 'Create the GitHub App',
        step: 'github',
        error,
        body: `<p>ProPR reads issues and opens pull requests as a GitHub App you own. GitHub creates it from a manifest with this instance's URLs filled in:</p>
<ul><li>Webhook: <code>${escapeHtml(publicUrl)}/webhook</code></li><li>Sign-in callback: <code>${escapeHtml(publicUrl)}/api/auth/github/callback</code></li></ul>
<form method="post" action="/setup/github/start">
<label for="org">Organization (optional)</label><input id="org" name="org" type="text" autocomplete="off" spellcheck="false" placeholder="Leave empty for your personal account">
<p class="hint">Create the App in an organization you administer, or in your personal account.</p>
<label for="name">App name (optional)</label><input id="name" name="name" type="text" autocomplete="off" maxlength="34" placeholder="ProPR-${escapeHtml(new URL(publicUrl).hostname.split('.')[0])}">
<p class="hint">GitHub App names are unique across GitHub. If the name is taken, change it on GitHub and submit again.</p>
<button type="submit">Continue to GitHub</button></form>`,
    });
}

export function manifestRedirectPage(action: string, manifest: unknown, nonce: string): string {
    return renderPage({
        title: 'Opening GitHub…',
        step: 'github',
        nonce,
        script: `document.getElementById('manifest-form').submit()`,
        body: `<form id="manifest-form" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<p>Review the App on GitHub and select <strong>Create GitHub App</strong>.</p><button type="submit">Continue to GitHub</button></form>`,
    });
}

export function installPage(slug: string, error?: string): string {
    return renderPage({
        title: 'Install the GitHub App',
        step: 'install',
        error,
        body: `<p>The App <strong>${escapeHtml(slug)}</strong> was created and its credentials were saved on this instance's volume.</p>
<p>Install it on the repositories ProPR should work on. Choose <strong>Only select repositories</strong> to limit what agents can reach.</p>
<a class="button" href="/setup/github/install">Install on GitHub</a>`,
    });
}

export function adminPage(repositories: string[], error?: string): string {
    const list = repositories.length
        ? `<p>Installed on ${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}: ${repositories.slice(0, 8).map(name => `<code>${escapeHtml(name)}</code>`).join(', ')}${repositories.length > 8 ? ', …' : ''}.</p>`
        : '<p>The App is installed.</p>';
    return renderPage({
        title: 'Sign in as the administrator',
        step: 'admin',
        error,
        body: `${list}<p>Sign in with GitHub. Your GitHub account becomes this instance's first administrator; you can add others later in Settings → Access.</p>
<a class="button" href="/setup/github/signin">Sign in with GitHub</a>`,
    });
}

/** Non-secret values to keep after a failed check; tokens are never rendered back. */
export interface RuntimeFormValues {
    runtime?: string;
    flyApp?: string;
    flyImage?: string;
    flyMachinesMax?: string;
}

export function runtimePage(admin: string, controlPlaneApp: string, error?: string, values: RuntimeFormValues = {}): string {
    const agentApp = `${controlPlaneApp || 'propr'}-agents`;
    const selected = ['sprites', 'fly-machines', 'none'].includes(values.runtime ?? '') ? values.runtime : 'sprites';
    const checked = (runtime: string): string => (runtime === selected ? ' checked' : '');
    const value = (field: string | undefined): string => (field ? ` value="${escapeHtml(field)}"` : '');
    return renderPage({
        title: 'Choose where agents run',
        step: 'runtime',
        error,
        body: `<p>Signed in as <strong>${escapeHtml(admin)}</strong>. Agents do not run on this Machine; pick a runtime. Each choice is checked before it is saved.</p>
<form method="post" action="/setup/runtime">
<fieldset><legend><label class="choice"><input type="radio" name="runtime" value="sprites"${checked('sprites')}> Sprites (recommended on the Free Plan)</label></legend>
<label for="spritesToken">Sprites token</label><input id="spritesToken" name="spritesToken" type="password" autocomplete="off">
<p class="hint">Create one at sprites.dev for the organization agents should use. ProPR starts with one Sprite at a time.</p></fieldset>
<fieldset><legend><label class="choice"><input type="radio" name="runtime" value="fly-machines"${checked('fly-machines')}> Fly Machines</label></legend>
<label for="flyApp">Agent app</label><input id="flyApp" name="flyApp" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(agentApp)}"${value(values.flyApp)}>
<label for="flyToken">Deploy token for the agent app</label><input id="flyToken" name="flyToken" type="password" autocomplete="off">
<p class="hint">Use a separate app that holds only agent Machines, and a token that can reach only it: in the Fly dashboard open that app → <strong>Tokens</strong> → <strong>Create deploy token</strong> (or <code>fly tokens create deploy --app ${escapeHtml(agentApp)} --expiry 8760h</code>). Never paste an organization or personal token.</p>
<label for="flyImage">Agent image</label><input id="flyImage" name="flyImage" type="text" autocomplete="off" spellcheck="false" placeholder="registry.fly.io/${escapeHtml(agentApp)}@sha256:…"${value(values.flyImage)}>
<p class="hint">Build it from <code>Dockerfile.agent</code> into the agent app (the fork's <strong>Build Fly agent image</strong> workflow prints the digest).</p>
<label for="flyMachinesMax">Agent Machines at once</label><input id="flyMachinesMax" name="flyMachinesMax" type="text" inputmode="numeric"${value(values.flyMachinesMax || '2')}>
<p class="hint">The Free Plan allows 3 Machines, stopped ones included: 3 minus this control plane and other apps' Machines.</p></fieldset>
<fieldset><legend><label class="choice"><input type="radio" name="runtime" value="none"${checked('none')}> Not yet (control plane only)</label></legend>
<p class="hint">ProPR starts without an agent runtime; agent runs fail with a clear error until you add one as a Fly secret (<code>SPRITES_TOKEN</code>, or the <code>PROPR_FLY_*</code> settings).</p></fieldset>
<button type="submit">Check and save</button></form>`,
    });
}

export function finishPage(runtime: string, error?: string): string {
    return renderPage({
        title: 'Start ProPR',
        step: 'finish',
        error,
        body: `<p>Agent runtime: <strong>${escapeHtml(runtime)}</strong>. Everything is saved on the volume and survives restarts and idle stops.</p>
<form method="post" action="/setup/finish">
<label class="choice"><input type="checkbox" name="idleShutdown" value="on"> Stop the Machine when idle (after 15 minutes without work)</label>
<p class="hint">Off by default. When on, the Machine stops itself when idle and any request (the UI, a GitHub webhook) starts it again in 10–20 seconds. Polling keeps it awake.</p>
<button type="submit">Finish setup and start ProPR</button></form>
<p class="hint">Next, sign in and add a model provider in Settings → Agents, as on any ProPR instance.</p>`,
    });
}

export function startingPage(): string {
    return renderPage({
        title: 'ProPR is starting',
        refreshSeconds: 20,
        body: `<p>Setup is complete and this page closes for good. ProPR is starting; this page opens the dashboard in about 20 seconds.</p>
<p>Then sign in with GitHub and add a model provider in <strong>Settings → Agents</strong>. Label an issue <code>AI</code> to get a pull request.</p>`,
    });
}

/** A setup step that finished after Finish: nothing of it was saved. */
export function setupCompletedPage(): string {
    return renderPage({
        title: 'Setup already completed',
        refreshSeconds: 20,
        body: `<p>Setup was finished while this step was still running, so its result was not saved. The settings chosen before Finish are kept.</p>
<p>To change a stored value now, set a Fly secret with the same name (or use the dashboard's Secrets page); it wins on the next boot.</p>`,
    });
}
