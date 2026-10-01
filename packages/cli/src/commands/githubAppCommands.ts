import { Command } from 'commander';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import { resolveSetupRoot } from '@propr/local-setup';
import { buildGithubAppManifest, githubAppPublicUrl, type GithubAppManifestOptions } from '@propr/shared';
import { createConfigManager } from '../config/index.js';
import { upsertEnvVars } from '../utils/envFile.js';
import { appJwt, githubAppRequest, checkGithubApp, type AppCredentials, type AppInstallation, type AppCheck } from './githubAppApi.js';

export interface GithubAppOptions extends GithubAppManifestOptions {
  root?: string;
  org?: string;
  webhookSecret?: string;
  browser?: boolean;
  force?: boolean;
  json?: boolean;
}
export interface GithubAppIo {
  log(message: string): void;
  ask(message: string, signal: AbortSignal): Promise<string>;
  open(url: string): Promise<void>;
}
export interface GithubAppDependencies {
  io?: GithubAppIo;
  fetcher?: typeof fetch;
  callbackTimeoutMs?: number;
  installationTimeoutMs?: number;
  signal?: AbortSignal;
}
export class GithubAppFlowError extends Error {}
function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GithubAppFlowError('GitHub App setup cancelled.');
}
function timeoutSignal(timeout: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
const credentialKeys = ['GH_APP_ID', 'GH_INSTALLATION_ID', 'HOST_GH_PRIVATE_KEY', 'GH_PRIVATE_KEY_PATH', 'GH_WEBHOOK_SECRET', 'GH_OAUTH_CLIENT_ID', 'GH_OAUTH_CLIENT_SECRET'];
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function registrationUrl(org?: string): string {
  if (org && !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(org)) throw new GithubAppFlowError('Use a GitHub organization login for --org.');
  return `https://github.com/${org ? `organizations/${org}/` : ''}settings/apps/new`;
}

/** Also usable as a portable file in SSH sessions; contains no App credentials. */
export function registrationPage(manifest: ReturnType<typeof buildGithubAppManifest>, action: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Create your ProPR GitHub App</title>
<body><main><h1>Create your ProPR GitHub App</h1><p>Continue to GitHub to create ${escapeHtml(manifest.name)}.</p>
<p>If the name is already taken, choose a unique name on GitHub and submit again.</p>
<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button>Create GitHub App</button></form>
<p>After creating and installing the App, return to the ProPR terminal. In SSH sessions, paste the redirect URL even if your browser cannot load it.</p></main>
<script>document.querySelector('form').submit()</script></body></html>`;
}

export function isPrivateGithubAppUrl(value: string): boolean {
  const host = githubAppPublicUrl(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (!host.includes('.') && isIP(host) !== 6) ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    /^(::(?:1$|$|ffff:)|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/.test(host);
}

export async function openGithubAppBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error('Browser unavailable')));
  });
}

/** Loopback-only receiver. Codes are single-use; setup callbacks are independently authenticated. */
export async function startGithubAppListener(state: string, ttlMs = 60 * 60_000) {
  const createdAt = Date.now();
  let html = '';
  let base = '';
  const used = new Set<string>();
  const queued = new Map<string, string | Error>();
  const waiters = new Map<string, (value: string | Error) => void>();
  const deliver = (kind: string, value: string | Error) => {
    const waiter = waiters.get(kind);
    if (waiter) { waiters.delete(kind); waiter(value); }
    else queued.set(kind, value);
  };
  function receive(raw: string, kind: 'created' | 'installed'): string {
    let url: URL;
    try { url = new URL(raw); } catch { throw new GithubAppFlowError('Paste the complete GitHub redirect URL.'); }
    if (Date.now() - createdAt >= ttlMs) throw new GithubAppFlowError('The GitHub registration session expired. Restart github-app create.');
    if (url.origin !== base || url.pathname !== `/${kind}` || url.searchParams.get('state') !== state) {
      throw new GithubAppFlowError('GitHub callback state or redirect URL did not match this session. Restart github-app create.');
    }
    if (used.has(kind)) throw new GithubAppFlowError('This GitHub callback has already been used.');
    const value = url.searchParams.get(kind === 'created' ? 'code' : 'installation_id');
    if (!value || !(kind === 'created' ? /^[a-zA-Z0-9_-]+$/ : /^\d+$/).test(value)) {
      throw new GithubAppFlowError(`GitHub callback is missing a valid ${kind === 'created' ? 'code' : 'installation_id'}.`);
    }
    used.add(kind);
    deliver(kind, value);
    return value;
  }
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' || request.headers.host !== new URL(base).host) { response.writeHead(400).end('Invalid request'); return; }
    const url = new URL(request.url!, base);
    if (url.pathname === `/register/${state}`) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return;
    }
    const kind = url.pathname === '/created' ? 'created' : url.pathname === '/installed' ? 'installed' : undefined;
    if (!kind) { response.writeHead(404).end(); return; }
    try {
      receive(url.href, kind);
      response.end('Received. Return to the ProPR terminal to continue.');
    } catch (error) {
      response.writeHead(400).end((error as Error).message);
      // A bad state cannot authorize conversion or installation verification.
      if (!used.has(kind)) deliver(kind, error as Error);
    }
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    setPage(page: string) { html = page; },
    receive,
    fromPaste(raw: string, kind: 'created' | 'installed'): string | undefined {
      // HTTP and paste-back feed one result. Only authorize a callback when no
      // successful HTTP delivery is queued; consuming it never resets replay protection.
      if (typeof queued.get(kind) !== 'string' && raw.trim()) receive(raw.trim(), kind);
      const value = queued.get(kind);
      queued.delete(kind);
      if (value instanceof Error) throw value;
      return value;
    },
    wait(kind: 'created' | 'installed', timeout: number, signal?: AbortSignal): Promise<string | undefined> {
      return new Promise((accept, reject) => {
        const abort = () => { waiters.delete(kind); clearTimeout(timer); reject(new GithubAppFlowError('GitHub App setup cancelled.')); };
        const finish = (value: string | Error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); value instanceof Error ? reject(value) : accept(value); };
        const timer = setTimeout(() => { waiters.delete(kind); signal?.removeEventListener('abort', abort); accept(undefined); }, timeout);
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        const value = queued.get(kind);
        if (value !== undefined) { queued.delete(kind); finish(value); }
        else waiters.set(kind, finish);
      });
    },
    close() { server.closeAllConnections(); server.close(); },
  };
}

function existingEnv(root: string): string { return existsSync(join(root, '.env')) ? readFileSync(join(root, '.env'), 'utf8') : ''; }
function assertNoCredentials(raw: string, force?: boolean): void {
  const env = parse(raw);
  if (!force && credentialKeys.some(key => env[key]?.trim())) {
    throw new GithubAppFlowError('Existing GitHub App credentials found. Use --force to replace them (a timestamped .env backup will be created).');
  }
}

/** Stage all writes before replacing .env; never overwrite a key belonging to another App. */
export function writeGithubAppConfig(root: string, credentials: AppCredentials, installationId: string, options: GithubAppOptions, initialEnv: string, signal?: AbortSignal) {
  checkCancellation(signal);
  const envPath = join(root, '.env');
  if (existingEnv(root) !== initialEnv) throw new GithubAppFlowError('.env changed during registration. Credentials were preserved in the recovery file; retry after reviewing .env.');
  assertNoCredentials(initialEnv, options.force);
  const keyPath = join(root, `github-app-${credentials.id}-${randomBytes(4).toString('hex')}.pem`);
  const vars: Record<string, string> = {
    GH_APP_ID: String(credentials.id), GH_INSTALLATION_ID: installationId, HOST_GH_PRIVATE_KEY: keyPath,
    GH_WEBHOOK_SECRET: credentials.webhook_secret, GITHUB_EVENT_INTAKE_MODE: 'direct_webhook',
    GH_OAUTH_CLIENT_ID: credentials.client_id, GH_OAUTH_CLIENT_SECRET: credentials.client_secret,
    GH_OAUTH_CALLBACK_URL: buildGithubAppManifest(options).callback_urls[0], GH_AUTH_MODE: 'app', PROPR_DEMO_MODE: 'false',
  };
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  const temporary = join(root, `.env.github-app-${stamp}`);
  let backupPath: string | undefined;
  try {
    const cleaned = initialEnv.split(/\r?\n/).filter(line => {
      const key = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line)?.[1];
      return !key || !(key in vars || key === 'GH_PRIVATE_KEY_PATH' || key === 'ENABLE_GITHUB_WEBHOOKS' || /^PROPR_(GH_RELAY_|ROUTING_)/.test(key));
    }).join('\n');
    writeFileSync(temporary, cleaned, { mode: 0o600, flag: 'wx' });
    upsertEnvVars(temporary, vars);
    if (existsSync(envPath)) {
      backupPath = `${envPath}.bak-${stamp}`;
      writeFileSync(backupPath, initialEnv, { mode: 0o600, flag: 'wx' });
    }
    writeFileSync(keyPath, credentials.pem, { mode: 0o600, flag: 'wx' });
    checkCancellation(signal);
    renameSync(temporary, envPath);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return { envPath, keyPath, backupPath, fields: Object.keys(vars) };
}

export async function createGithubApp(options: GithubAppOptions, dependencies: GithubAppDependencies = {}) {
  checkCancellation(dependencies.signal);
  const manifestOptions = buildGithubAppManifest(options); // Validate before opening GitHub or touching files.
  const target = registrationUrl(options.org);
  if (options.webhookSecret !== undefined && (!options.webhookSecret || /[\r\n]|^\s|\s$|\s#/.test(options.webhookSecret) || parse(`GH_WEBHOOK_SECRET=${options.webhookSecret}`).GH_WEBHOOK_SECRET !== options.webhookSecret)) {
    throw new GithubAppFlowError('The webhook secret must be a non-empty, single-line env-compatible value.');
  }
  const root = resolve(options.root ?? resolveSetupRoot(await createConfigManager()));
  checkCancellation(dependencies.signal);
  const raw = existingEnv(root);
  assertNoCredentials(raw, options.force);
  mkdirSync(root, { recursive: true });
  const fetcher = dependencies.fetcher ?? fetch;
  let readline: ReturnType<typeof createInterface> | undefined;
  const io: GithubAppIo = dependencies.io ?? {
    log: message => console.error(message),
    ask: (message, signal) => {
      readline ??= createInterface({ input: process.stdin, output: process.stderr });
      return readline.question(`${message} `, { signal });
    },
    open: openGithubAppBrowser,
  };
  if (isPrivateGithubAppUrl(options.publicUrl) || isPrivateGithubAppUrl(manifestOptions.hook_attributes.url)) {
    io.log('Warning: the public or webhook URL is loopback/private. GitHub must reach /webhook; use ProPR Connect for machines without a public URL.');
  }
  const state = randomBytes(32).toString('hex');
  const listener = await startGithubAppListener(state);
  let recoveryPath: string | undefined;
  let registrationPath: string | undefined;
  try {
    checkCancellation(dependencies.signal);
    const manifest = buildGithubAppManifest({ ...options, redirectUrl: `${listener.base}/created`, setupUrl: `${listener.base}/installed?state=${state}` });
    const page = registrationPage(manifest, `${target}?state=${state}`);
    listener.setPage(page);
    let paste = options.browser === false;
    const localUrl = `${listener.base}/register/${state}`;
    io.log(`Opening GitHub to create ${JSON.stringify(manifest.name)}. If the name is taken, edit it on GitHub and submit again.`);
    if (!paste) {
      io.log(localUrl);
      try { await io.open(localUrl); } catch { paste = true; io.log('Could not open a browser. Use the portable registration page below.'); }
    }
    checkCancellation(dependencies.signal);
    if (paste) {
      registrationPath = join(root, `github-app-register-${randomBytes(4).toString('hex')}.html`);
      writeFileSync(registrationPath, page, { mode: 0o600, flag: 'wx' });
      io.log(`Registration page: ${pathToFileURL(registrationPath).href}\nFor SSH, copy this HTML file to your browser's machine and open it there. It submits the manifest to ${target}.\nAlternatively, forward the loopback port and open ${localUrl}.`);
    }
    const timeout = dependencies.callbackTimeoutMs ?? 55 * 60_000;
    const code = paste
      ? listener.fromPaste(await io.ask('Paste the complete creation redirect URL (including code and state):', timeoutSignal(timeout, dependencies.signal)), 'created')
      : await listener.wait('created', timeout, dependencies.signal);
    checkCancellation(dependencies.signal);
    if (!code) throw new GithubAppFlowError('Timed out waiting for GitHub registration. Retry with --no-browser to paste the redirect URL.');
    const credentials = await githubAppRequest<AppCredentials>(`/app-manifests/${encodeURIComponent(code)}/conversions`, undefined, 'POST', undefined, fetcher, dependencies.signal);
    if (!Number.isSafeInteger(credentials.id) || !/^[a-zA-Z0-9-]+$/.test(credentials.slug) ||
        !['pem', 'webhook_secret', 'client_id', 'client_secret'].every(key => typeof credentials[key as keyof AppCredentials] === 'string' && credentials[key as keyof AppCredentials])) {
      throw new GithubAppFlowError('GitHub returned incomplete App credentials. Check the new App in GitHub settings.');
    }
    // Preserve a completed one-shot conversion even if cancellation arrived while
    // awaiting it. Cancellation prevents configuration writes, not recovery writes.
    recoveryPath = join(root, `github-app-${credentials.id}-recovery.json`);
    writeFileSync(recoveryPath, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
    checkCancellation(dependencies.signal);
    io.log(`App created (id ${credentials.id}).`);
    if (options.webhookSecret !== undefined) {
      checkCancellation(dependencies.signal);
      await githubAppRequest('/app/hook/config', appJwt(credentials.id, credentials.pem), 'PATCH', { secret: options.webhookSecret, content_type: 'json' }, fetcher, dependencies.signal);
      // Keep recovery data aligned with a confirmed remote update before stopping.
      credentials.webhook_secret = options.webhookSecret;
      writeFileSync(recoveryPath, JSON.stringify(credentials), { mode: 0o600 });
    }
    checkCancellation(dependencies.signal);
    const installUrl = `https://github.com/apps/${credentials.slug}/installations/new`;
    io.log(`Install it on your repositories: ${installUrl}`);
    if (!paste) { try { await io.open(installUrl); } catch { paste = true; } }
    checkCancellation(dependencies.signal);
    let installationId: string | undefined;
    const installTimeout = dependencies.installationTimeoutMs ?? 5 * 60_000;
    if (paste) {
      try {
        const redirect = await io.ask('After installing, paste the complete installation redirect URL (or press Enter to discover the installation):', timeoutSignal(installTimeout, dependencies.signal));
        checkCancellation(dependencies.signal);
        installationId = listener.fromPaste(redirect, 'installed');
      } catch (error) {
        checkCancellation(dependencies.signal);
        if (!['AbortError', 'TimeoutError'].includes((error as Error).name)) throw error;
        installationId = listener.fromPaste('', 'installed');
      }
    } else installationId = await listener.wait('installed', installTimeout, dependencies.signal);
    checkCancellation(dependencies.signal);
    if (!installationId) {
      const installations = await githubAppRequest<AppInstallation[]>('/app/installations', appJwt(credentials.id, credentials.pem), 'GET', undefined, fetcher, dependencies.signal);
      checkCancellation(dependencies.signal);
      if (installations.length !== 1) throw new GithubAppFlowError('Could not identify a single installation. Finish installing the new App on GitHub.');
      installationId = String(installations[0].id);
    }
    // Verify even a browser-provided ID with App authentication; never trust the callback.
    const installation = await githubAppRequest<AppInstallation>(`/app/installations/${installationId}`, appJwt(credentials.id, credentials.pem), 'GET', undefined, fetcher, dependencies.signal);
    checkCancellation(dependencies.signal);
    if (installation.app_id !== credentials.id || String(installation.id) !== installationId) throw new GithubAppFlowError('The installation does not belong to the newly created App.');
    const result = writeGithubAppConfig(root, credentials, installationId, options, raw, dependencies.signal);
    unlinkSync(recoveryPath); recoveryPath = undefined;
    io.log(`Installed (installation ${installationId}).\nWrote private key ${result.keyPath} (0600).\nUpdated ${result.envPath}: ${result.fields.join(', ')}`);
    let checks: AppCheck[];
    try { checks = await checkGithubApp(credentials.id, installationId, credentials.pem, fetcher, dependencies.signal); }
    catch { checks = [{ name: 'GitHub App', status: 'fail', detail: 'Credentials saved, but GitHub validation failed. Run propr check to retry.' }]; }
    checkCancellation(dependencies.signal);
    for (const check of checks) if (check.status !== 'ok') io.log(`${check.status}: ${check.detail}`);
    io.log('Next: propr start --restart');
    return { ...result, checks };
  } catch (error) {
    if (recoveryPath) io.log(`App credentials are preserved in ${recoveryPath} (0600). Do not create another App; use https://docs.propr.dev/docs/operations/github-auth#manual-registration-and-interrupted-setup.`);
    checkCancellation(dependencies.signal);
    if (error instanceof GithubAppFlowError) throw error;
    // Filesystem and transport errors can contain secret input; expose only controlled messages.
    if (error instanceof Error && /^(GitHub |Cannot sign a GitHub)/.test(error.message)) throw new GithubAppFlowError(error.message);
    throw new GithubAppFlowError('GitHub App setup did not complete. Check filesystem access and network connectivity, then retry.');
  } finally {
    listener.close(); readline?.close();
    if (registrationPath && existsSync(registrationPath)) unlinkSync(registrationPath);
  }
}

export function createGithubAppCommand(dependencies: GithubAppDependencies = {}): Command {
  const command = new Command('github-app').description('Create and configure your own self-hosted GitHub App');
  for (const name of ['create', 'manifest'] as const) {
    const child = new Command(name).description(name === 'create' ? 'Create, install, and save a GitHub App using the manifest flow' : 'Write a manifest and env template for manual registration')
      .requiredOption('--public-url <url>', 'Public URL of this ProPR stack')
      .option('--org <login>', 'Organization that will own the App')
      .option('--name <name>', 'App name (must be globally unique)')
      .option('--webhook-url <url>', 'Override the public /webhook URL')
      .option('--webhook-secret <secret>', 'Override the GitHub-generated webhook signing secret')
      .option('--allow-workflow-changes', 'Request Workflows write permission for edits to .github/workflows/*')
      .option('--root <dir>', 'Stack root directory')
      .option('--no-browser', 'Use a portable HTML form and paste GitHub redirect URLs (SSH)')
      .option('--force', 'Replace existing credentials or manifest output files')
      .option('--json', 'Print field names and file paths only to stdout; progress goes to stderr')
      .action(async (options: GithubAppOptions) => {
        try {
          if (name === 'create') {
            const result = await createGithubApp(options, dependencies);
            if (options.json) console.log(JSON.stringify({ fields: result.fields, envPath: result.envPath, keyPath: result.keyPath, backupPath: result.backupPath }));
            if (result.checks.some(check => check.status === 'fail')) process.exitCode = 1;
          } else {
            const result = await writeGithubAppManifest(options);
            console.log(options.json ? JSON.stringify(result) : `Wrote ${result.manifestPath}\nWrote ${result.envSnippetPath}\nPOST the manifest to ${registrationUrl(options.org)}; fill in the env template after registration.`);
          }
        } catch (error) {
          console.error(error instanceof GithubAppFlowError ? error.message : 'Could not configure the GitHub App. Check your options, filesystem access, and network connection.');
          process.exitCode = 1;
        }
      });
    command.addCommand(child);
  }
  return command;
}

export async function writeGithubAppManifest(options: GithubAppOptions) {
  const manifest = buildGithubAppManifest(options);
  registrationUrl(options.org);
  const root = resolve(options.root ?? resolveSetupRoot(await createConfigManager()));
  const manifestPath = join(root, 'github-app-manifest.json');
  const envSnippetPath = join(root, 'github-app.env.example');
  if (!options.force && [manifestPath, envSnippetPath].some(existsSync)) throw new GithubAppFlowError('Manifest output already exists. Use --force to replace it.');
  mkdirSync(root, { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  // No secrets in this file. A manifest cannot specify GitHub's webhook secret.
  const snippet = `# Register by POSTing the manifest to ${registrationUrl(options.org)}.\n# Fill these after manual registration. Set the same webhook secret on GitHub.\nGH_APP_ID=\nGH_INSTALLATION_ID=\nHOST_GH_PRIVATE_KEY=\nGH_WEBHOOK_SECRET=\nGH_OAUTH_CLIENT_ID=\nGH_OAUTH_CLIENT_SECRET=\nGH_OAUTH_CALLBACK_URL=${manifest.callback_urls[0]}\nGH_AUTH_MODE=app\nPROPR_DEMO_MODE=false\nGITHUB_EVENT_INTAKE_MODE=direct_webhook\n# Remove PROPR_GH_RELAY_* and PROPR_ROUTING_* from the stack .env.\n`;
  writeFileSync(envSnippetPath, snippet, { mode: 0o600 });
  return { manifestPath, envSnippetPath };
}
