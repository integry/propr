// CORS origin validation shared between Express and Socket.IO.
//
// The hosted UI origin (FRONTEND_URL, e.g. https://app.propr.dev) is always
// allowed. When COOKIE_DOMAIN is set, the base domain and any of its subdomains
// are also allowed so PR preview environments that share sessions via
// cross-subdomain cookies can talk to the API. localhost/127.0.0.1/[::1] are
// allowed for local development.

import type { ErrorRequestHandler, RequestHandler } from 'express';
import cors from 'cors';
import { validatedConnectOrigin } from './connectAuth.js';
import {
  DESKTOP_RENDERER_ORIGIN,
  parseProprConnectEndpoint,
  canonicalProprHttpUrlOrigin,
  isProprLoopbackHostname,
  normalizeProprApiOrigin,
} from '@propr/shared';

export type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;
export type CorsOriginValidator = (origin: string | undefined, callback: CorsOriginCallback) => void;

// Desktop REST requests carry a scoped authentication marker, so browsers
// preflight them. Cache successful policy checks briefly to avoid repeating an
// OPTIONS request for every read while still revalidating policy changes within
// a bounded interval.
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 10 * 60;

export class CorsOriginError extends Error {
  constructor() {
    super('CORS origin rejected');
    this.name = 'CorsOriginError';
  }
}

// Remote MCP clients can execute requests from a browser-originated fetch even
// though their OAuth exchange runs in the provider's cloud. Keep this exception
// to the exact MCP endpoint and known product origin; it must never widen the
// cookie-authenticated REST or Socket.IO boundaries.
const MCP_WEB_CLIENT_ORIGINS = new Set(['https://claude.ai']);

export function isTrustedMcpWebOrigin(path: string, origin: string | undefined): origin is string {
  return path === '/api/mcp' && origin !== undefined && MCP_WEB_CLIENT_ORIGINS.has(origin);
}

/**
 * Handle validator failures before Express's environment-dependent default
 * error renderer can expose an HTML stack trace. Keep one public response for
 * malformed and merely-disallowed origins so rejection details are not leaked.
 */
export const corsRejectionHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (!(error instanceof CorsOriginError)) {
    next(error);
    return;
  }
  res.status(403).json({ error: 'CORS origin rejected' });
};

// Builds a CORS origin validator bound to a specific frontend URL and optional
// cookie domain. Throws if frontendUrl is not a valid URL so callers can fail
// fast at startup.
export function createCorsOriginValidator(frontendUrl: string, cookieDomain: string | undefined): CorsOriginValidator {
  // Remove leading dot if present for hostname matching
  const baseDomain = cookieDomain?.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
  const frontendOrigin = canonicalProprHttpUrlOrigin(frontendUrl, { allowInsecureHttp: true });
  if (!frontendOrigin) throw new Error('FRONTEND_URL must contain a canonical HTTP(S) URL');

  return function validateCorsOrigin(origin: string | undefined, callback: CorsOriginCallback): void {
    // Allow requests with no origin (e.g., mobile apps, curl, etc.)
    if (!origin) {
      callback(null, true);
      return;
    }
    // Electron registers this as a standard, secure scheme, which gives the
    // packaged renderer a stable serialized origin. Match that origin exactly;
    // never accept the generic `null` value used by arbitrary opaque origins.
    if (origin === DESKTOP_RENDERER_ORIGIN) {
      callback(null, true);
      return;
    }
    try {
      const canonicalOrigin = normalizeProprApiOrigin(origin, { allowInsecureHttp: true });
      if (!canonicalOrigin) throw new CorsOriginError();
      const url = new URL(canonicalOrigin);
      // Allow the base domain and any subdomain. The previous inline validator
      // allowed both http and https here, and some non-tunnel PR-preview
      // deployments still use http://<sub>.<cookie-domain>. Keep that existing
      // behavior; tunnel-specific hardening must not silently break previews.
      if (
        baseDomain &&
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        (url.hostname === baseDomain || url.hostname.endsWith('.' + baseDomain))
      ) {
        callback(null, true);
      } else if (url.origin === frontendOrigin) {
        callback(null, true);
      } else if (
        isProprLoopbackHostname(url.hostname) &&
        (url.protocol === 'http:' || url.protocol === 'https:')
      ) {
        // Allow loopback hosts for development, but only over http/https so an
        // unusual scheme (e.g. file:, chrome-extension:) is not trusted.
        callback(null, true);
      } else {
        callback(new CorsOriginError());
      }
    } catch {
      callback(new CorsOriginError());
    }
  };
}

/**
 * Connect uses the existing host-only instance session. Only canonical hosted
 * tunnels share its HTTPS site; this does not solve third-party cookie policy
 * for cross-site self-hosted deployments. Never add Connect to the validator
 * shared with Socket.IO or infer authority from Host/Forwarded request headers.
 */
export function createConnectStorageCorsMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const connectOrigin = validatedConnectOrigin(env.PROPR_CONNECT_URL);
  const connectUrl = new URL(connectOrigin);
  const hosted = parseProprConnectEndpoint(env.API_PUBLIC_URL);
  const sameSite = hosted && connectUrl.hostname.endsWith('.propr.dev') && !connectUrl.port;
  const base = '/api/instance/storage/v1';
  const routes = new Map([
    ['/api/auth/user', ['GET']],
    [`${base}/capabilities`, ['GET']],
    [`${base}/repositories`, ['GET']],
    [`${base}/exports`, ['POST']],
    [`${base}/usage`, ['GET']],
    [`${base}/policy`, ['GET', 'PUT']],
    [`${base}/cleanup/preview`, ['POST']],
    [`${base}/cleanup/execute`, ['POST']],
  ]);
  const operationPath = /^\/api\/instance\/storage\/v1\/cleanup\/operations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return (req, res, next) => {
    if (!sameSite || req.get('Origin') !== connectOrigin) { next(); return; }
    const exportPath = /^\/api\/instance\/storage\/v1\/exports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/(?:download|cancel))?$/.exec(req.path);
    const methods = routes.get(req.path) ?? (operationPath.test(req.path) ? ['GET'] : exportPath ? [exportPath[1] ? 'POST' : 'GET'] : []);
    const method = req.method === 'OPTIONS' ? req.get('Access-Control-Request-Method') : req.method;
    const mutation = method === 'PUT' || method === 'POST';
    const allowedHeaders = mutation ? ['content-type', 'x-propr-storage'] : [];
    const requestedHeaders = (req.get('Access-Control-Request-Headers') ?? '')
      .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (!method || !methods.includes(method)
      || requestedHeaders.some(header => !allowedHeaders.includes(header))) {
      // No exception: preserve any explicitly configured existing UI policy.
      // Default Fleet's validator rejects Connect here, including preflights.
      next(); return;
    }
    cors({
      origin: connectOrigin,
      credentials: true,
      methods: [method],
      allowedHeaders,
      maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
    })(req, res, error => {
      if (error) { next(error); return; }
      // Signal only that CORS was handled; authentication/authorization must
      // still run. OPTIONS ends in cors without creating a session or grant.
      res.locals.connectStorageCors = true;
      next();
    });
  };
}
