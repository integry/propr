import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The API process's response boundary: security headers on every response and
 * JSON for every error it produces. Express's own final handler renders HTML,
 * with a stack trace and container paths outside production; nothing here
 * includes an error message, stack or file path from the thrown error.
 */

export interface ApiErrorBody { error: string; code: string; }

const CLIENT_ERRORS: Record<number, ApiErrorBody> = {
  400: { error: 'Bad request', code: 'BAD_REQUEST' },
  401: { error: 'Authentication required', code: 'UNAUTHORIZED' },
  403: { error: 'Forbidden', code: 'FORBIDDEN' },
  404: { error: 'Not found', code: 'NOT_FOUND' },
  405: { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' },
  413: { error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' },
  415: { error: 'Unsupported media type', code: 'UNSUPPORTED_MEDIA_TYPE' },
  429: { error: 'Too many requests', code: 'RATE_LIMITED' },
};

// body-parser (via raw-body and http-errors) tags its failures with `type`.
const BODY_ERRORS: Record<string, ApiErrorBody> = {
  'entity.parse.failed': { error: 'Request body is not valid JSON', code: 'INVALID_JSON' },
  'entity.too.large': { error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' },
  'entity.verify.failed': { error: 'Request body was rejected', code: 'INVALID_REQUEST_BODY' },
  'request.aborted': { error: 'Request body was not received completely', code: 'INVALID_REQUEST_BODY' },
  'request.size.invalid': { error: 'Request body length does not match Content-Length', code: 'INVALID_REQUEST_BODY' },
  'charset.unsupported': { error: 'Unsupported request body charset', code: 'UNSUPPORTED_MEDIA_TYPE' },
  'encoding.unsupported': { error: 'Unsupported request body encoding', code: 'UNSUPPORTED_MEDIA_TYPE' },
};

// Multer's limit errors carry a code but no HTTP status.
const MULTER_LIMIT_CODES = new Set(['LIMIT_PART_COUNT', 'LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_FIELD_KEY', 'LIMIT_FIELD_VALUE', 'LIMIT_FIELD_COUNT']);

function errorProperty(error: unknown, name: string): unknown {
  return error !== null && typeof error === 'object' ? (error as Record<string, unknown>)[name] : undefined;
}

/** HTTP status and safe JSON body for an error that reached the API boundary. */
export function describeApiError(error: unknown): { status: number; body: ApiErrorBody } {
  if (errorProperty(error, 'name') === 'MulterError') {
    const code = errorProperty(error, 'code');
    return MULTER_LIMIT_CODES.has(String(code))
      ? { status: 413, body: CLIENT_ERRORS[413] }
      : { status: 400, body: { error: 'Invalid multipart upload', code: 'INVALID_UPLOAD' } };
  }
  const rawStatus = Number(errorProperty(error, 'status') ?? errorProperty(error, 'statusCode'));
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
  if (status >= 500) return { status, body: { error: 'Internal server error', code: 'INTERNAL_ERROR' } };
  const type = errorProperty(error, 'type');
  const bodyError = typeof type === 'string' ? BODY_ERRORS[type] : undefined;
  if (bodyError) return { status, body: bodyError };
  // A decompression failure (`Content-Encoding: gzip` with a non-gzip body) has no type.
  if (status === 400 && typeof errorProperty(error, 'errno') === 'number') {
    return { status, body: { error: 'Request body could not be decoded', code: 'INVALID_REQUEST_BODY' } };
  }
  return { status, body: CLIENT_ERRORS[status] ?? { error: 'Request could not be processed', code: 'BAD_REQUEST' } };
}

function sendApiError(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  const { status, body } = describeApiError(error);
  if (status >= 500) {
    // Log the cause server-side only; the response never carries it.
    console.error(`[api] Unhandled error for ${req.method} ${(req.url ?? '').split('?')[0]}:`, error);
  }
  if (res.headersSent) {
    // Matches Express: a started response cannot be replaced, so end the connection.
    req.socket.destroy();
    return;
  }
  // Drop headers a failed handler may have set for its intended response.
  for (const name of ['content-disposition', 'content-encoding', 'content-length', 'content-type', 'etag', 'last-modified']) res.removeHeader(name);
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(req.method === 'HEAD' ? undefined : payload);
}

/** Answers a request no route handled: JSON 404 instead of `Cannot GET …`. */
function sendNotFound(req: IncomingMessage, res: ServerResponse): void {
  if (res.headersSent) { req.socket.destroy(); return; }
  const payload = JSON.stringify(CLIENT_ERRORS[404]);
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(req.method === 'HEAD' ? undefined : payload);
}

/**
 * Error middleware for the request body parsers. Placed right after them so a
 * malformed, oversized or undecodable body is answered as JSON before
 * authentication, rate limiting by route or any route-specific error handler.
 */
export function bodyParserErrorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  const { status } = describeApiError(error);
  if (status >= 500) { next(error); return; }
  sendApiError(req, res, error);
}

/**
 * Replaces Express's HTML final handler for the whole application. Express
 * calls it after the last layer, so it also covers routes mounted after start
 * (the lazily initialized MCP browser routes) without being reordered by them.
 */
export function installApiFinalHandler(app: Express): void {
  const handle = (app as unknown as { handle: (req: IncomingMessage, res: ServerResponse, callback?: (error?: unknown) => void) => void }).handle.bind(app);
  (app as unknown as { handle: typeof handle }).handle = (req, res, callback) => {
    handle(req, res, callback ?? (error => {
      if (error) sendApiError(req, res, error);
      else sendNotFound(req, res);
    }));
  };
}

/**
 * Headers every API response carries. `WWW-Authenticate` is added when the
 * response is committed, so every 401 gets it, including ones written by
 * route handlers, without overriding a challenge a handler already set (MCP).
 */
export const apiSecurityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const writeHead = res.writeHead;
  res.writeHead = function writeHeadWithChallenge(this: Response, ...args: Parameters<typeof writeHead>) {
    const status = typeof args[0] === 'number' ? args[0] : this.statusCode;
    if (status === 401 && !this.hasHeader('WWW-Authenticate')) this.setHeader('WWW-Authenticate', 'Bearer');
    return writeHead.apply(this, args);
  } as typeof writeHead;
  next();
};
