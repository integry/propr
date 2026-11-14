import { randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { EXTENSION_OAUTH_PATHS, type ExtensionOAuthInstanceInfo } from '@propr/shared';
import { ExtensionError, type ExtensionLibraryStore } from '../../core/src/extensions/extensionProfileStore.js';
import { extensionOAuth, type ExtensionOAuthUrls } from '../../core/src/extensions/extensionOAuthStore.js';
import { clientMetadataDocument } from '../../core/src/extensions/extensionOAuth.js';
import { derivePublicOrigin } from '../mcp/configResolver.js';
import { isDemoViewer } from '../demoMode.js';

/**
 * The instance URLs an OAuth sign-in needs, from the public API base URL the
 * MCP OAuth server also uses. Without a public HTTPS base URL Connect is unavailable.
 */
export function extensionOAuthUrls(environment: NodeJS.ProcessEnv = process.env): ExtensionOAuthUrls {
  const origin = derivePublicOrigin(environment);
  return origin ? { redirectUri: `${origin}${EXTENSION_OAUTH_PATHS.callback}`, clientMetadataUrl: `${origin}${EXTENSION_OAUTH_PATHS.clientMetadata}` } : { redirectUri: null, clientMetadataUrl: null };
}

export async function extensionOAuthInstanceInfo(store: ExtensionLibraryStore, library: { instanceId: string; servers: Parameters<ReturnType<typeof extensionOAuth>['statuses']>[1] }, environment: NodeJS.ProcessEnv = process.env): Promise<ExtensionOAuthInstanceInfo> {
  return { ...extensionOAuthUrls(environment), connections: await extensionOAuth(store).statuses(library.instanceId, library.servers) };
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
/** The small page the provider redirects to: it tells the Settings tab to refresh and can be closed. */
function resultPage(res: Response, { status, title, message, outcome }: { status: number; title: string; message: string; outcome: 'connected' | 'failed' }) {
  const nonce = randomBytes(16).toString('base64');
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  }).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · ProPR</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f8fafc;color:#0f172a}main{max-width:28rem;padding:1.5rem;border:1px solid #e2e8f0;border-radius:.5rem;background:#fff}h1{font-size:1.125rem;margin:0 0 .5rem}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>You can close this tab; the Settings tab refreshes when you return to it.</p></main>
<script nonce="${nonce}">(function(){var m={type:'propr-extension-oauth',outcome:'${outcome}'};try{new BroadcastChannel('propr-extension-oauth').postMessage(m)}catch(e){}try{if(window.opener)window.opener.postMessage(m,'*')}catch(e){}})();</script></body></html>`);
}

type Handle = (run: (req: Request, actor: string) => Promise<unknown>) => RequestHandler;
const scopesOf = (value: unknown) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32 || value.some(scope => typeof scope !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope))) throw new ExtensionError(400, 'Invalid OAuth scopes');
  return value as string[];
};

/** OAuth sign-in routes of the extension library. `handle` applies the library's administrator and preflight checks. */
export function createExtensionOAuthRoutes(store: ExtensionLibraryStore, handle: Handle, environment: NodeJS.ProcessEnv = process.env) {
  const exact = (req: Request, keys: string[]) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(k => !keys.includes(k))) throw new ExtensionError(400, 'Invalid extension request');
  };
  return {
    /** Discovery for the server form; stores nothing and uses no credential. */
    oauthCheck: handle(async (req, actor) => {
      exact(req, ['url', 'clientId', 'scopes']);
      if (typeof req.body.url !== 'string' || (req.body.clientId !== undefined && (typeof req.body.clientId !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(req.body.clientId)))) throw new ExtensionError(400, 'HTTPS endpoint required');
      try { new URL(req.body.url); } catch { throw new ExtensionError(400, 'HTTPS endpoint required'); }
      return { check: await extensionOAuth(store).check(actor, { url: req.body.url, clientId: req.body.clientId, scopes: scopesOf(req.body.scopes) }, extensionOAuthUrls(environment)) };
    }),
    /** Start a sign-in bound to this browser session; returns the provider's authorization URL. */
    oauthStart: handle(async (req, actor) => {
      exact(req, ['name']);
      if (typeof req.body.name !== 'string') throw new ExtensionError(400, 'Invalid extension item');
      return extensionOAuth(store).startSignIn(actor, req.sessionID, req.body.name, extensionOAuthUrls(environment));
    }),
    oauthDisconnect: handle(async (req, actor) => {
      exact(req, ['name']);
      if (typeof req.body.name !== 'string') throw new ExtensionError(400, 'Invalid extension item');
      return extensionOAuth(store).disconnect(actor, req.body.name);
    }),
    oauthAudit: handle(async (_req, actor) => ({ events: await extensionOAuth(store).audit(actor) })),
    /** The provider's redirect. Completes only for the administrator session that started the sign-in. */
    oauthCallback: (async (req, res) => {
      if (isDemoViewer(req.authorization)) { resultPage(res, { status: 403, title: 'Sign-in unavailable', message: 'The demo does not connect MCP servers.', outcome: 'failed' }); return; }
      try {
        if (!req.user?.id) throw new ExtensionError(401, 'Sign in to ProPR in this browser first');
        if (req.authorization?.role !== 'admin' || !req.authorization.permissions.includes('instance.manage_settings')) throw new ExtensionError(403, 'Instance settings administration is required');
        const query = req.query as Record<string, unknown>;
        const { name } = await extensionOAuth(store).completeSignIn(req.user.id, req.sessionID, { state: query.state, code: query.code, error: query.error, iss: query.iss });
        resultPage(res, { status: 200, title: 'Connected', message: `The MCP server ${name} is connected.`, outcome: 'connected' });
      } catch (error) {
        resultPage(res, { status: error instanceof ExtensionError ? error.status : 400, title: 'Sign-in not completed', message: error instanceof ExtensionError ? error.message : 'Sign-in failed', outcome: 'failed' });
      }
    }) as RequestHandler,
    /** ProPR's public Client ID Metadata Document; its URL is the client id. Unauthenticated by design. */
    clientMetadata: ((_req, res) => {
      const urls = extensionOAuthUrls(environment);
      if (!urls.clientMetadataUrl || !urls.redirectUri) { res.status(404).json({ error: 'No public base URL is configured' }); return; }
      res.set('Cache-Control', 'public, max-age=300').json(clientMetadataDocument(urls.clientMetadataUrl, urls.redirectUri));
    }) as RequestHandler,
  };
}
