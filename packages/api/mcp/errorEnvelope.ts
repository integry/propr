import { z } from 'zod';
import type { McpError } from './config.js';

/** Stable locations a tool may expose without leaking implementation detail. */
export type McpErrorStage = 'validation' | 'authorization' | 'precondition' | 'github' | 'transport' | 'database' | 'queue' | 'workflow' | 'internal';

/** The one public and durable representation of an MCP tool failure. */
export interface McpErrorEnvelope {
  code: string;
  message: string;
  stage: McpErrorStage | null;
  retryable: boolean;
  status: number;
  details?: Record<string, unknown>;
  cause?: { code: string; message: string };
}

const SENSITIVE_DETAIL_KEY = /token|secret|password|authorization|cookie|private.?key|credential/i;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g;
const MCP_TOKEN = /\b(?:pia|propr)_mcp_[A-Za-z0-9._~-]+\b/g;
const BEARER_VALUE = /\bBearer\s+[^\s,;"']+/gi;
const CREDENTIALED_GIT_URL = /(https:\/\/x-access-token:)[^@\s/]+(@[^\s]+)/gi;
const SIGNED_QUERY_VALUE = /([?&](?:X-Amz-Signature|token|access_token|signature)=)[^&#\s]*/gi;

/** Remove credentials that can occur in upstream messages and safe detail values. */
export function redactSecrets(value: string): string {
  return value
    .replace(GITHUB_TOKEN, '[REDACTED]')
    .replace(MCP_TOKEN, '[REDACTED]')
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(CREDENTIALED_GIT_URL, '$1[REDACTED]$2')
    .replace(SIGNED_QUERY_VALUE, '$1[REDACTED]');
}

function basename(value: string): string {
  const withoutTrailingSeparator = value.replace(/[\\/]+$/, '');
  return withoutTrailingSeparator.split(/[\\/]/).pop() || '[REDACTED_PATH]';
}

function stripAbsolutePaths(value: string): string {
  const posix = value.replace(/(^|[\s("'=])\/(?:[^/\s"'<>]+\/)+([^/\s"'<>]+)/g, (_match, prefix: string, filename: string) => `${prefix}${filename}`);
  return posix.replace(/(^|[\s("'=])(?:[A-Za-z]:[\\/]|\\\\)(?:[^\\/\s"'<>]+[\\/])+([^\\/\s"'<>]+)/g,
    (_match, prefix: string, filename: string) => `${prefix}${filename}`);
}

const PATH_LIKE_KEY_WORDS = new Set([
  'path', 'paths', 'file', 'files', 'filename', 'filenames', 'filepath', 'filepaths',
  'dir', 'dirs', 'directory', 'directories', 'folder', 'folders', 'root', 'roots', 'cwd', 'workdir', 'workspace',
]);

/**
 * Whether a detail key names a filesystem location (`path`, `logsPath`,
 * `source_file`, `directories`, ...). Only such fields are reduced to a
 * basename as a whole; free-text fields such as `reason`, `error` or `title`
 * keep a leading slash (for example a `/merge` command title) and are only
 * stripped of multi-segment absolute paths inside their prose.
 */
export function isPathLikeDetailKey(key: string): boolean {
  const lastWord = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_.-]+/).filter(Boolean).pop();
  return lastWord !== undefined && PATH_LIKE_KEY_WORDS.has(lastWord.toLowerCase());
}

function redactDetailValue(value: unknown, seen: WeakSet<object>, pathLike: boolean): unknown {
  if (typeof value === 'string') {
    const redacted = redactSecrets(value);
    // Path-like fields carry a location directly: keep only the filename for
    // POSIX, Windows-drive and UNC absolute paths. Every other string is
    // diagnostic prose, where only embedded absolute paths are reduced.
    if (pathLike && (redacted.startsWith('/') || /^[A-Za-z]:[\\/]/.test(redacted))) return basename(redacted);
    return stripAbsolutePaths(redacted);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[REDACTED]';
    seen.add(value);
    // Items of `files: [...]` inherit the path-like treatment of their key.
    return value.map(item => redactDetailValue(item, seen, pathLike));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[REDACTED]';
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_DETAIL_KEY.test(key)) continue;
      result[redactSecrets(key)] = redactDetailValue(item, seen, isPathLikeDetailKey(key));
    }
    return result;
  }
  if (typeof value === 'bigint') return String(value);
  return value;
}

/** Recursively sanitize optional structured error detail. Sensitive keys are omitted. */
export function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return redactDetailValue(details, new WeakSet(), false) as Record<string, unknown>;
}

type ErrorLike = {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  status?: unknown;
  request?: unknown;
  response?: unknown;
  cause?: unknown;
};

function errorLike(value: unknown): ErrorLike | undefined {
  return value !== null && typeof value === 'object' ? value as ErrorLike : undefined;
}

function isMcpError(value: unknown): value is McpError {
  return value instanceof Error
    && value.name === 'McpError'
    && typeof (value as Partial<McpError>).code === 'string'
    && typeof (value as Partial<McpError>).status === 'number'
    && typeof (value as Partial<McpError>).toEnvelope === 'function';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function finiteStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function githubError(error: unknown): { value: ErrorLike; status: number; response?: Record<string, unknown> } | undefined {
  const value = errorLike(error);
  if (!value) return undefined;
  const response = record(value.response);
  const status = finiteStatus(value.status) ?? finiteStatus(response?.status);
  if (!status) return undefined;
  // RequestError uses name=HttpError and carries request/response metadata.
  // Accept response-bearing test doubles too, without mistaking every domain
  // error with an HTTP-like status for a GitHub failure.
  if (value.name !== 'HttpError' && value.request === undefined && !response) return undefined;
  return { value, status, response };
}

function githubHeaders(response: Record<string, unknown> | undefined): Record<string, unknown> {
  const source = record(response?.headers);
  if (!source) return {};
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]));
}

function githubMessage(value: ErrorLike, response: Record<string, unknown> | undefined): string {
  const data = record(response?.data);
  const primary = typeof data?.message === 'string' ? data.message
    : typeof value.message === 'string' ? value.message : 'GitHub rejected the request.';
  const errors = Array.isArray(data?.errors) ? data.errors.flatMap(item => {
    if (typeof item === 'string') return [item];
    const message = record(item)?.message;
    return typeof message === 'string' ? [message] : [];
  }) : [];
  const additions = errors.filter(message => message && message !== primary);
  return redactSecrets([primary, ...additions].join(': '));
}

function classifyGithub(error: unknown): McpErrorEnvelope | undefined {
  const github = githubError(error);
  if (!github) return undefined;
  const { value, status, response } = github;
  const headers = githubHeaders(response);
  const rateLimited = status === 429 || (status === 403 && (
    String(headers['x-ratelimit-remaining'] ?? '') === '0'
    || headers['retry-after'] !== undefined
  ));
  const common = { stage: 'github' as const, status, message: githubMessage(value, response) };
  if (rateLimited) return { code: 'GITHUB_RATE_LIMITED', retryable: true, ...common };
  if (status === 401) return { code: 'GITHUB_AUTH_FAILED', retryable: false, ...common };
  if (status === 403) return { code: 'GITHUB_FORBIDDEN', retryable: false, ...common };
  if (status === 404) return { code: 'GITHUB_NOT_FOUND', retryable: false, ...common };
  if (status >= 500) return { code: 'GITHUB_UNAVAILABLE', retryable: true, ...common };
  if (status === 409 || status === 422 || (status >= 400 && status < 500)) {
    return { code: 'GITHUB_REJECTED', retryable: false, ...common };
  }
  return undefined;
}

function errorChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && chain.length < 5) {
    seen.add(current);
    const value = errorLike(current);
    if (!value) break;
    chain.push(value);
    current = value.cause;
  }
  return chain;
}

function classifyKnown(error: unknown): McpErrorEnvelope {
  if (isMcpError(error)) return error.toEnvelope();

  if (error instanceof z.ZodError) {
    return {
      code: 'INVALID_INPUT',
      message: 'Invalid or missing tool arguments.',
      stage: 'validation',
      retryable: false,
      status: 400,
      details: redactDetails({ issues: error.issues.map(issue => ({
        path: issue.path.map(part => typeof part === 'symbol' ? part.description ?? 'symbol' : part),
        message: issue.message,
      })) }),
    };
  }

  const github = classifyGithub(error);
  if (github) return github;

  const chain = errorChain(error);
  if (chain.some(item => item.name === 'AbortError' || item.name === 'TimeoutError' || item.code === 'ETIMEDOUT')) {
    return { code: 'UPSTREAM_TIMEOUT', message: 'The upstream request timed out.', stage: 'transport', retryable: true, status: 504 };
  }
  if (chain.some(item => ['ECONNRESET', 'ECONNREFUSED'].includes(String(item.code)))) {
    return { code: 'UPSTREAM_UNREACHABLE', message: 'The upstream service could not be reached.', stage: 'transport', retryable: true, status: 503 };
  }
  if (chain.some(item => ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String(item.code)))) {
    return { code: 'DATABASE_BUSY', message: 'The database is temporarily busy.', stage: 'database', retryable: true, status: 503 };
  }
  return { code: 'INTERNAL_ERROR', message: 'The request could not be completed.', stage: 'internal', retryable: false, status: 500 };
}

const NO_SIDE_EFFECTS = Symbol.for('propr.mcp.noSideEffects');

/**
 * Run the read phase of a mutation. A failure raised here happened before any
 * external write, so the runner reports it as an ordinary, often retryable,
 * error instead of an uncertain outcome that the caller must go and inspect.
 */
export async function beforeSideEffects<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error && typeof error === 'object') {
      Object.defineProperty(error, NO_SIDE_EFFECTS, { value: true, enumerable: false, configurable: true });
    }
    throw error;
  }
}

/** Whether a failure was raised by a read phase that provably issued no external write. */
export function raisedBeforeSideEffects(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as Record<symbol, unknown>)[NO_SIDE_EFFECTS] === true;
}

/** Classify any thrown value, retaining mutation uncertainty when effects may have occurred. */
export function classifyError(error: unknown, options: { sideEffectsPossible: boolean }): McpErrorEnvelope {
  const classified = classifyKnown(error);
  const sideEffectsPossible = options.sideEffectsPossible && !raisedBeforeSideEffects(error);
  if (!sideEffectsPossible || (isMcpError(error) && classified.status < 500)) return classified;
  return {
    code: 'OUTCOME_UNKNOWN',
    message: 'Outcome uncertain. Inspect the target before issuing a new action.',
    stage: classified.stage,
    retryable: false,
    status: classified.status,
    cause: { code: classified.code, message: redactSecrets(classified.message) },
  };
}

/** Produce the protocol result understood by both text-only and structured clients. */
export function toToolErrorResult(envelope: McpErrorEnvelope): {
  isError: true;
  content: [{ type: 'text'; text: string }];
  structuredContent: { error: McpErrorEnvelope };
} {
  const safe: McpErrorEnvelope = {
    ...envelope,
    message: redactSecrets(envelope.message),
    ...(envelope.details ? { details: redactDetails(envelope.details) } : {}),
    ...(envelope.cause ? { cause: { code: envelope.cause.code, message: redactSecrets(envelope.cause.message) } } : {}),
  };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: safe }) }], structuredContent: { error: safe } };
}
