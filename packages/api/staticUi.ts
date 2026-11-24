/**
 * Same-origin Web UI serving for the slim (all-in-one) control plane.
 *
 * The multi-container stack ships the UI in its own `serve -s dist` container.
 * The all-in-one profile drops that container: the API serves the prebuilt
 * bundle itself, so the browser talks to one origin for the UI, REST and
 * Socket.IO. This mirrors the UI image contract (propr-ui/serve.json and
 * propr-ui/docker-entrypoint.sh):
 *
 * - `/config.js` is generated at startup and never cached. Its API base URL
 *   comes from PROPR_SERVED_UI_API_URL and defaults to empty (same origin).
 *   It deliberately does not reuse PROPR_UI_PUBLIC_API_URL: in tunnel mode
 *   that is the hosted proxy URL the *hosted* UI calls, while the bundle served
 *   here always shares the API's own origin.
 * - `/service-worker.js` and `index.html` must revalidate on every load so a
 *   new release is picked up; hashed assets are immutable.
 * - Unknown non-API paths fall back to `index.html` (client-side routing), but
 *   server-owned paths (REST, Socket.IO, webhooks, MCP/OAuth) are never
 *   swallowed by the SPA fallback: they reach their routes or the JSON 404.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Path prefixes the API owns; the SPA fallback must never answer them. */
export const SERVER_OWNED_PATH_PREFIXES = Object.freeze([
  '/api',
  '/socket.io',
  '/webhook',
  '/health',
  '/mcp',
  '/authorize',
  '/token',
  '/register',
  '/revoke',
  '/.well-known',
]);

export interface StaticUiOptions {
  /** Directory containing the built UI (index.html, assets/, config.js). */
  distDir: string;
  /** Browser-visible API origin written into config.js; empty = same origin. */
  publicApiUrl?: string;
}

export interface StaticUiResolution {
  enabled: boolean;
  distDir?: string;
  publicApiUrl: string;
  /** Why serving is disabled (or failed to resolve); undefined when enabled. */
  reason?: string;
}

function isServerOwnedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SERVER_OWNED_PATH_PREFIXES.some(prefix => lower === prefix || lower.startsWith(`${prefix}/`));
}

/**
 * The exact runtime config the UI image's entrypoint writes. JSON.stringify
 * covers every string hazard except U+2028/U+2029, which terminate a line
 * inside a JS string literal and are escaped explicitly.
 */
export function renderRuntimeConfigScript(publicApiUrl = ''): string {
  const json = JSON.stringify({ apiBaseUrl: publicApiUrl || '' }).replace(
    /[\u2028\u2029]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `window.__PROPR_CONFIG__ = ${json};\n`;
}

/** The serialized origin of an http(s) URL, or undefined when absent/invalid. */
export function publicOriginOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** Default locations for a bundle shipped inside the app image or a source checkout. */
function defaultDistCandidates(cwd: string): string[] {
  return [join(cwd, 'propr-ui', 'dist'), join(cwd, '..', '..', 'propr-ui', 'dist')];
}

/**
 * Decide whether (and from where) to serve the UI. Serving is opt-in:
 * PROPR_SERVE_UI=1 enables it with the default bundle location, and an
 * explicit PROPR_UI_DIST_DIR enables it from that directory. A requested but
 * missing bundle is reported rather than silently ignored.
 */
export function resolveStaticUi(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): StaticUiResolution {
  const publicApiUrl = env.PROPR_SERVED_UI_API_URL ?? '';
  const explicitDir = env.PROPR_UI_DIST_DIR?.trim();
  const requested = Boolean(explicitDir) || truthy(env.PROPR_SERVE_UI);
  if (!requested) {
    return { enabled: false, publicApiUrl, reason: 'PROPR_SERVE_UI is not enabled' };
  }
  const candidates = explicitDir
    ? [isAbsolute(explicitDir) ? explicitDir : resolve(cwd, explicitDir)]
    : defaultDistCandidates(cwd);
  const distDir = candidates.find(dir => existsSync(join(dir, 'index.html')) && statSync(dir).isDirectory());
  if (!distDir) {
    return {
      enabled: false,
      publicApiUrl,
      reason: `no built UI (index.html) found in ${candidates.join(' or ')}; build propr-ui or set PROPR_UI_DIST_DIR`,
    };
  }
  return { enabled: true, distDir, publicApiUrl };
}

/**
 * Mount the static UI on `app`. Must be installed before CORS: module scripts
 * are fetched with an Origin header even on the same origin, and static assets
 * carry no credentials that CORS would need to protect.
 */
export function mountStaticUi(app: Express, options: StaticUiOptions): void {
  const distDir = resolve(options.distDir);
  const indexPath = join(distDir, 'index.html');
  // Read once: the bundle is immutable for the lifetime of the process.
  const indexHtml = readFileSync(indexPath);
  const configScript = renderRuntimeConfigScript(options.publicApiUrl);

  const uiHeaders = (res: Response): void => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  };

  app.get('/config.js', (_req: Request, res: Response) => {
    uiHeaders(res);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('application/javascript').send(configScript);
  });

  const serveStatic = express.static(distDir, {
    index: false,
    fallthrough: true,
    dotfiles: 'ignore',
    setHeaders: (res, filePath) => {
      uiHeaders(res);
      if (filePath.endsWith('service-worker.js')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (filePath.endsWith('.html') || filePath.endsWith('.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes(`${join(distDir, 'assets')}`)) {
        // Vite fingerprints everything under assets/.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (isServerOwnedPath(req.path)) return next();
    serveStatic(req, res, (error?: unknown) => {
      if (error) return next(error);
      // SPA fallback: only for navigations, never for missing assets, so a
      // stale hashed chunk is a real 404 rather than HTML parsed as script.
      const lastSegment = req.path.split('/').pop() ?? '';
      const acceptsHtml = req.accepts(['html', 'json']) === 'html';
      if (!acceptsHtml || lastSegment.includes('.')) return next();
      uiHeaders(res);
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(indexHtml);
    });
  });
}
