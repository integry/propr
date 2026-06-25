// CORS origin validation shared between Express and Socket.IO.
//
// The hosted UI origin (FRONTEND_URL, e.g. https://app.propr.dev) is always
// allowed. When COOKIE_DOMAIN is set, the base domain and any of its subdomains
// are also allowed so PR preview environments that share sessions via
// cross-subdomain cookies can talk to the API. localhost/127.0.0.1 are allowed
// for local development.

export type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;
export type CorsOriginValidator = (origin: string | undefined, callback: CorsOriginCallback) => void;

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
      // Allow the base domain and any subdomain. Cookie-domain sessions are
      // secure cookies, so require https here (except localhost, handled below)
      // to avoid trusting an http:// look-alike on the same domain.
      if (
        baseDomain &&
        url.protocol === 'https:' &&
        (url.hostname === baseDomain || url.hostname.endsWith('.' + baseDomain))
      ) {
        callback(null, true);
      } else if (url.origin === frontendOrigin) {
        callback(null, true);
      } else if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        // Allow localhost for development
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    } catch {
      callback(new Error('Invalid origin'));
    }
  };
}
