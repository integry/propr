// CORS origin validation shared between Express and Socket.IO.
//
// The hosted UI origin (FRONTEND_URL, e.g. https://app.propr.dev) is always
// allowed. When COOKIE_DOMAIN is set, the base domain and any of its subdomains
// are also allowed so PR preview environments that share sessions via
// cross-subdomain cookies can talk to the API. localhost/127.0.0.1 are allowed
// for local development.

import type { ErrorRequestHandler } from 'express';

export type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;
export type CorsOriginValidator = (origin: string | undefined, callback: CorsOriginCallback) => void;

export class CorsOriginError extends Error {
  constructor() {
    super('CORS origin rejected');
    this.name = 'CorsOriginError';
  }
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
  const frontendOrigin = new URL(frontendUrl).origin;

  return function validateCorsOrigin(origin: string | undefined, callback: CorsOriginCallback): void {
    // Allow requests with no origin (e.g., mobile apps, curl, etc.)
    if (!origin) {
      callback(null, true);
      return;
    }
    try {
      const url = new URL(origin);
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
        (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
        (url.protocol === 'http:' || url.protocol === 'https:')
      ) {
        // Allow localhost for development, but only over http/https so an unusual
        // scheme (e.g. file:, chrome-extension:) on localhost is not trusted.
        callback(null, true);
      } else {
        callback(new CorsOriginError());
      }
    } catch {
      callback(new CorsOriginError());
    }
  };
}
