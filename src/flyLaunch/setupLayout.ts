/**
 * Layout of the Fly dashboard launch setup wizard (#3827): the ProPR look
 * (the Web UI's colors, type, buttons, inputs and cards from
 * propr-ui/tailwind.config.js and src/index.css, inlined), the header with its
 * small "on Fly.io" accent, the step progress indicator, and the one script
 * every page loads from /setup/assets/wizard.js.
 *
 * Like the Web UI, the wizard has a single light theme in every OS color
 * scheme. Pages work without JavaScript: the script only adds busy states
 * to submit buttons, copy buttons and the agent-app name in the command.
 */
import { FAVICON_PNG, LOGO_PNG, LOGO_SIZE } from './setupAssetData.js';

export type SetupStep = 'claim' | 'github' | 'install' | 'signin-app' | 'admin' | 'runtime' | 'finish';
/** `connect`: the shared ProPR App (the default); `own-app`: an App created with the manifest flow. */
export type GithubPath = 'connect' | 'own-app';

type StepList = ReadonlyArray<{ id: SetupStep; label: string }>;

/** Steps of the own-App path. */
export const SETUP_STEPS: StepList = [
    { id: 'claim', label: 'Setup code' },
    { id: 'github', label: 'GitHub App' },
    { id: 'install', label: 'Install' },
    { id: 'admin', label: 'Administrator' },
    { id: 'runtime', label: 'Agent runtime' },
    { id: 'finish', label: 'Start' },
];

/** Steps of the ProPR App path, also shown before a path is chosen (it is the default). */
export const CONNECT_SETUP_STEPS: StepList = [
    { id: 'claim', label: 'Setup code' },
    { id: 'github', label: 'GitHub' },
    { id: 'signin-app', label: 'Sign-in app' },
    { id: 'admin', label: 'Administrator' },
    { id: 'runtime', label: 'Agent runtime' },
    { id: 'finish', label: 'Start' },
];

const stepsFor = (path: GithubPath | undefined): StepList => (path === 'own-app' ? SETUP_STEPS : CONNECT_SETUP_STEPS);

export const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Attributes of every link that leaves the wizard: a new tab, so the wizard keeps its place. */
export const EXTERNAL = 'target="_blank" rel="noopener noreferrer"';
export const externalLink = (href: string, text: string, className = ''): string =>
    `<a${className ? ` class="${className}"` : ''} href="${escapeHtml(href)}" ${EXTERNAL}>${text}<span class="ext" aria-hidden="true">↗</span><span class="sr"> (opens in a new tab)</span></a>`;

/** A "Why?" disclosure for anything longer than the one-sentence hint. */
export const why = (body: string, summary = 'Why?'): string => `<details class="why"><summary>${summary}</summary><div>${body}</div></details>`;

/** The instance the wizard sets up, for the header. */
export interface InstanceInfo {
    /** `<app>.fly.dev`, or the API_PUBLIC_URL host. */
    host: string;
    /** FLY_APP_NAME, linked to the app's Fly dashboard page. */
    app?: string;
}

export const ASSET_PATHS = { logo: '/setup/assets/logo.png', favicon: '/setup/assets/favicon.png', script: '/setup/assets/wizard.js' } as const;

// Tokens from propr-ui: primary-500/600/700 (#24A3A3/#1D8A8A/#167575),
// light-100 (#F8F9FA), card-border (#E2E8F0) and Tailwind's gray, red and green.
// --fly is Fly.io's purple, used only for the small "on Fly.io" accent.
const STYLE = `
:root{color-scheme:light;--bg:#F8F9FA;--card:#fff;--line:#E2E8F0;--input:#D1D5DB;--text:#1F2937;--strong:#111827;--muted:#4B5563;--faint:#6B7280;
--primary:#1D8A8A;--primary-hover:#167575;--primary-ring:#24A3A3;--primary-soft:#E6F4F4;--error:#B91C1C;--error-bg:#FEF2F2;--ok:#15803D;--ok-bg:#F0FDF4;--fly:#7C3AED}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:var(--primary)}a:hover{color:var(--primary-hover)}.ext{margin-left:2px;font-size:.85em}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
main{max-width:680px;margin:0 auto;padding:20px 16px 48px}
header.brand{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:4px 0 20px}
header.brand img{display:block;height:32px;width:auto}
.on-fly{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--faint);padding:3px 10px;border:1px solid var(--line);border-radius:999px;background:var(--card)}
.on-fly::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--fly)}
.on-fly a{color:var(--fly);font-weight:600;text-decoration:none}.on-fly a:hover{text-decoration:underline;color:var(--fly)}
.on-fly .host{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--muted)}
h1{font-size:20px;line-height:1.3;color:var(--strong);margin:0 0 4px;font-weight:600}h2{font-size:17px;color:var(--strong);margin:0 0 12px;font-weight:600}
.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:24px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
ol.progress{display:flex;list-style:none;padding:0;margin:0 0 20px;counter-reset:step}
ol.progress li{flex:1;position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12px;color:var(--faint);text-align:center;min-width:0}
ol.progress li::after{content:"";position:absolute;top:13px;left:calc(50% + 17px);right:calc(-50% + 17px);height:2px;background:var(--line)}
ol.progress li:last-child::after{display:none}ol.progress li.done::after{background:var(--primary)}
ol.progress .dot{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;border:2px solid var(--input);background:var(--card);color:var(--faint)}
ol.progress li.done .dot{background:var(--primary);border-color:var(--primary);color:#fff}
ol.progress li.current .dot{border-color:var(--primary);color:var(--primary);box-shadow:0 0 0 4px var(--primary-soft)}
ol.progress li.current{color:var(--strong);font-weight:600}ol.progress li.done{color:var(--muted)}
@media (max-width:560px){ol.progress li:not(.current) .label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}ol.progress li.current .label{white-space:nowrap}}
label{display:block;font-weight:500;font-size:14px;color:var(--strong);margin:16px 0 6px}
input[type=text],input[type=password]{width:100%;padding:8px 12px;border:1px solid var(--input);border-radius:6px;background:#fff;color:var(--text);font:inherit;box-shadow:0 1px 2px rgba(0,0,0,.05)}
input[type=text]:focus,input[type=password]:focus{outline:none;border-color:var(--primary-ring);box-shadow:0 0 0 3px rgba(36,163,163,.25)}
input[type=radio],input[type=checkbox]{accent-color:var(--primary);width:16px;height:16px}
.code{font:600 20px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}
.hint{color:var(--faint);font-size:13px;margin:6px 0 0}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;margin-top:20px;padding:9px 16px;border:0;border-radius:6px;background:var(--primary);color:#fff;font:500 15px/1.25 inherit;font-family:inherit;text-decoration:none;cursor:pointer;transition:background-color .15s}
button:hover,.button:hover{background:var(--primary-hover);color:#fff}button:focus-visible,.button:focus-visible{outline:2px solid var(--primary-ring);outline-offset:2px}
button:disabled,.button[aria-disabled=true]{background:#9CA3AF;cursor:progress}
button.copy{margin:0;padding:4px 10px;font-size:12px;background:#fff;color:var(--muted);border:1px solid var(--input)}button.copy:hover{background:var(--bg);color:var(--strong)}
.spinner{width:15px;height:15px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spinner{animation-duration:2s}}
.error{background:var(--error-bg);color:var(--error);border-radius:6px;padding:10px 12px;margin:0 0 16px;font-size:14px}
.notice{background:var(--ok-bg);color:var(--ok);border-radius:6px;padding:10px 12px;margin:0 0 16px;font-size:14px}.notice strong{color:var(--ok)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#F3F4F6;border-radius:4px;padding:1px 4px}ul{padding-left:20px}
.path,.option{border:1px solid var(--line);border-radius:8px;padding:16px;margin:0 0 16px}.path h3{font-size:15px;color:var(--strong);margin:0 0 4px}
.badge{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;background:var(--primary-soft);color:var(--primary-hover);font-size:12px;font-weight:600;vertical-align:1px}
ol.todo{padding-left:20px;margin:8px 0 0}ol.todo li{margin:0 0 8px}a.secondary{display:inline-block;margin-top:4px;font-weight:600}
details.path summary,details.why summary,details.advanced summary{cursor:pointer;font-weight:600;color:var(--muted)}details.path[open] summary{margin-bottom:8px}
details.why{margin:6px 0 0;font-size:13px;color:var(--faint)}details.why summary{font-weight:500;font-size:13px;color:var(--primary);display:inline}details.why div{margin:4px 0 0}
details.advanced{margin:16px 0 0;font-size:14px}details.advanced>div{margin-top:8px;color:var(--muted)}
fieldset.runtimes{border:0;padding:0;margin:8px 0 0}fieldset.runtimes legend{font-weight:500;font-size:14px;color:var(--strong);padding:0;margin:0 0 8px}
.option{padding:12px 14px;margin:0 0 8px}.option:has(input:checked){border-color:var(--primary);box-shadow:0 0 0 1px var(--primary)}
.option>label.choice{margin:0;display:flex;gap:10px;align-items:baseline;font-weight:600;cursor:pointer}.option .desc{font-weight:400;color:var(--faint);font-size:13px}
label.choice{display:flex;gap:8px;align-items:baseline;font-weight:500;margin:12px 0 0}label.choice input{margin:0;flex:none;transform:translateY(2px)}
.panel{margin:4px 0 0 26px}@supports selector(:has(*)){.option:not(:has(input[name=runtime]:checked)) .panel{display:none}}
ol.scope{margin:8px 0 0;padding-left:20px;font-size:13px;color:var(--muted)}ol.scope li{margin:0 0 2px}
.cmd{display:flex;gap:8px;align-items:flex-start;margin:8px 0 0}.cmd pre{flex:1;margin:0;padding:8px 10px;background:#111827;color:#F9FAFB;border-radius:6px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.warn{border-left:3px solid var(--primary);padding:2px 0 2px 10px;margin:12px 0 0}`;

/**
 * Busy states for every wizard submit: the button is disabled at once and
 * shows a spinner and its data-busy label, a second submit is dropped, and a
 * page restored from the back/forward cache gets its buttons back. A failed
 * submit answers with the same page and an inline error, so the button is
 * fresh. Links styled as buttons (GitHub sign-in, install) get the same.
 */
export const WIZARD_SCRIPT = `(function(){
var spin=function(el,label){el.setAttribute('data-idle',el.innerHTML);el.setAttribute('aria-busy','true');
el.innerHTML='<span class="spinner" aria-hidden="true"></span>';el.appendChild(document.createTextNode(label||'Working\\u2026'));};
document.addEventListener('submit',function(e){var form=e.target;if(form.getAttribute('data-submitting')){e.preventDefault();return;}
form.setAttribute('data-submitting','1');var b=e.submitter||form.querySelector('button[type=submit],button:not([type])');
if(b){spin(b,b.getAttribute('data-busy'));b.disabled=true;}});
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a.button[data-busy]');if(!a)return;
if(a.getAttribute('aria-disabled')==='true'){e.preventDefault();return;}spin(a,a.getAttribute('data-busy'));a.setAttribute('aria-disabled','true');});
window.addEventListener('pageshow',function(e){if(!e.persisted)return;document.querySelectorAll('[data-idle]').forEach(function(el){
el.innerHTML=el.getAttribute('data-idle');el.removeAttribute('data-idle');el.removeAttribute('aria-busy');el.removeAttribute('aria-disabled');el.disabled=false;});
document.querySelectorAll('form[data-submitting]').forEach(function(f){f.removeAttribute('data-submitting');});});
document.querySelectorAll('.cmd').forEach(function(box){if(!navigator.clipboard)return;var pre=box.querySelector('pre');var b=document.createElement('button');
b.type='button';b.className='copy';b.textContent='Copy';b.addEventListener('click',function(){navigator.clipboard.writeText(pre.textContent).then(function(){
b.textContent='Copied';setTimeout(function(){b.textContent='Copy';},1500);});});box.appendChild(b);});
var app=document.getElementById('flyApp');if(app)app.addEventListener('input',function(){var v=app.value.trim()||app.placeholder;
document.querySelectorAll('[data-agent-app]').forEach(function(s){s.textContent=v;});});
})();`;

/** Static wizard assets: served to anyone, as they hold nothing about the instance. */
export function setupAsset(pathname: string): { type: string; body: Buffer | string } | undefined {
    if (pathname === ASSET_PATHS.logo) return { type: 'image/png', body: Buffer.from(LOGO_PNG, 'base64') };
    if (pathname === ASSET_PATHS.favicon) return { type: 'image/png', body: Buffer.from(FAVICON_PNG, 'base64') };
    if (pathname === ASSET_PATHS.script) return { type: 'text/javascript; charset=utf-8', body: WIZARD_SCRIPT };
    return undefined;
}

export interface PageOptions {
    title: string;
    step?: SetupStep;
    /** Which path's step list to show; the ProPR App path by default. */
    path?: GithubPath;
    error?: string;
    /** What the previous step verified, shown above this step (plain text). */
    notice?: string;
    body: string;
    nonce?: string;
    script?: string;
    refreshSeconds?: number;
}

function progress(current: SetupStep | undefined, path: GithubPath | undefined): string {
    if (!current) return '';
    const steps = stepsFor(path);
    const index = steps.findIndex(step => step.id === current);
    return `<ol class="progress" aria-label="Setup steps">${steps.map((step, i) => {
        const state = i < index ? 'done' : i === index ? 'current' : 'upcoming';
        const status = state === 'done' ? ' (done)' : state === 'current' ? ' (current)' : '';
        return `<li class="${state}"${i === index ? ' aria-current="step"' : ''}><span class="dot" aria-hidden="true">${state === 'done' ? '✓' : i + 1}</span><span class="label"><span class="sr">${i + 1}. </span>${step.label}<span class="sr">${status}</span></span></li>`;
    }).join('')}</ol>`;
}

function brandHeader(instance: InstanceInfo): string {
    const fly = instance.app ? externalLink(`https://fly.io/apps/${encodeURIComponent(instance.app)}`, 'Fly.io') : 'Fly.io';
    return `<header class="brand"><img src="${ASSET_PATHS.logo}" alt="ProPR" width="${LOGO_SIZE.width}" height="${LOGO_SIZE.height}">
<span class="on-fly">on ${fly}<span class="host">${escapeHtml(instance.host)}</span></span></header>`;
}

export function renderPage(instance: InstanceInfo, options: PageOptions): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">${options.refreshSeconds ? `<meta http-equiv="refresh" content="${options.refreshSeconds};url=/">` : ''}
<title>${escapeHtml(options.title)} · ProPR setup</title><link rel="icon" type="image/png" href="${ASSET_PATHS.favicon}"><style>${STYLE}</style>
<script src="${ASSET_PATHS.script}" defer></script></head>
<body><main>${brandHeader(instance)}<h1>Set up ProPR</h1><p class="sub">First-visit setup for this Fly instance.</p>${progress(options.step, options.path)}
<section class="card"><h2>${escapeHtml(options.title)}</h2>${options.notice ? `<p class="notice" role="status"><strong>✓ Checked:</strong> ${escapeHtml(options.notice)}</p>` : ''}${options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ''}${options.body}</section>
</main>${options.script && options.nonce ? `<script nonce="${options.nonce}">${options.script}</script>` : ''}</body></html>`;
}
