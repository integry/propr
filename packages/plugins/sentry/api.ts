import { PluginDeliveryError, PluginSdkError, parsePluginRetryAfter, pluginHttpsUrlProblem, type PluginContext, type PluginJsonValue, type PluginSettingValues } from '@propr/shared';

/**
 * Sentry's web API (https://docs.sentry.io/api/), under `<Sentry URL>/api/0/`,
 * through `ctx.http('auth-token')`: ProPR sends the internal integration's
 * token as `Authorization: Bearer <token>`
 * (https://docs.sentry.io/api/auth/) and only to the host of the Sentry URL
 * setting (`outboundHostsFromSettings`), which must be a public `https://`
 * host name: sentry.io, a region such as de.sentry.io, or a self-hosted
 * Sentry. Errors are reported by HTTP status only: Sentry's error bodies may
 * quote input, so they are never repeated. Rate limits answer 429 with
 * `Retry-After` (https://docs.sentry.io/api/ratelimits/).
 *
 * Endpoints used:
 * - `GET organizations/<org>/issues/<id>/`: the issue (permission `event:read`).
 * - `GET organizations/<org>/issues/<id>/events/latest/`: its latest event
 *   (https://docs.sentry.io/api/events/retrieve-an-issue-event/).
 * - `POST organizations/<org>/issues/<id>/notes/` with `{ text }`: a note in
 *   the issue's activity (`event:write`), as Sentry's own MCP server posts
 *   them.
 * - `PUT organizations/<org>/issues/<id>/` with `{ status: "resolved" }`
 *   (https://docs.sentry.io/api/events/update-an-issue/; `event:write`).
 * - `GET organizations/<org>/projects/`: the projects, for the settings form
 *   (`project:read`).
 */

export const AUTH_TOKEN = 'auth-token';
export const DEFAULT_SENTRY_URL = 'https://sentry.io';
export const ORGANIZATION = /^[a-z0-9][a-z0-9_-]{0,49}$/;
export const ISSUE_ID = /^\d{1,20}$/;
/** A project reference in the mapping: a slug or a numeric id. */
export const PROJECT_REFERENCE = /^(?:[a-z0-9][a-z0-9_-]{0,99}|\d{1,20})$/i;

export const NOT_CONNECTED = 'Sentry is not connected yet. Set the Sentry URL and organization slug, save, set the internal integration token under Connections, then choose Reload choices.';

const PERMANENT_SDK_CODES = new Set(['host_not_allowed', 'insecure_url', 'private_address', 'invalid_input', 'permission_denied']);

/** The Sentry URL's origin (`https://sentry.io`), or null when it is not an acceptable URL. */
export function sentryOrigin(settings: PluginSettingValues): string | null {
  const value = settings.baseUrl;
  const url = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_SENTRY_URL;
  return pluginHttpsUrlProblem(url) ? null : new URL(url).origin;
}

/** The organization slug setting, or null when unset or not a slug. */
export function sentryOrganization(settings: PluginSettingValues): string | null {
  const value = typeof settings.organization === 'string' ? settings.organization.trim().toLowerCase() : '';
  return ORGANIZATION.test(value) ? value : null;
}

/**
 * The id a Sentry issue is recorded under: the Sentry host, the organization
 * and the issue id (`sentry.io/acme/4501`). After the Sentry URL or the
 * organization changes, another Sentry's issue with the same id is neither a
 * duplicate nor updated by the sync-back of one handed over before.
 */
export const recordId = (origin: string, organization: string, id: string): string => `${new URL(origin).host}/${organization}/${id}`;

/** The issue id of a recorded issue when it belongs to the Sentry and organization the settings name now, else null. */
export function issueOnSite(settings: PluginSettingValues, record: string): string | null {
  const origin = sentryOrigin(settings);
  const organization = sentryOrganization(settings);
  if (!origin || !organization) return null;
  const prefix = `${new URL(origin).host}/${organization}/`;
  const id = record.startsWith(prefix) ? record.slice(prefix.length) : '';
  return ISSUE_ID.test(id) ? id : null;
}

/** The Sentry web page of an issue, built from the settings, never from the payload. */
export const issueWebUrl = (origin: string, organization: string, id: string): string => `${origin}/organizations/${organization}/issues/${id}/`;

/** A refusal from Sentry; `permanent` unless it may succeed later. Its message holds only a coded reason. */
export class SentryApiError extends Error {
  readonly name = 'SentryApiError';
  constructor(readonly code: string, readonly permanent: boolean, readonly retryAfterMs: number | null = null) { super(`Sentry answered ${code}`); }
}

const CODES: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED' };

/** One request to `<Sentry URL>/api/0/<path>`; returns the parsed JSON body (null for an empty one). */
export async function sentryRequest<T>(ctx: PluginContext, method: 'GET' | 'POST' | 'PUT', path: string, json?: Record<string, PluginJsonValue>): Promise<T | null> {
  const origin = sentryOrigin(ctx.settings);
  if (!origin || !sentryOrganization(ctx.settings)) throw new PluginDeliveryError(NOT_CONNECTED, { permanent: true });
  let status: number; let retryAfter: string | undefined; let text: string;
  try {
    const response = await ctx.http(AUTH_TOKEN)(`${origin}/api/0/${path}`, {
      method, headers: { accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) }, ...(json ? { json } : {}),
    });
    status = response.status; retryAfter = response.headers['retry-after'];
    text = (await response.text()).slice(0, 1_000_000);
  } catch (error) {
    const sdk = error instanceof PluginSdkError ? error : null;
    if (sdk?.code === 'connection_unavailable') throw new PluginDeliveryError(NOT_CONNECTED, { permanent: true });
    if (sdk && PERMANENT_SDK_CODES.has(sdk.code)) throw new PluginDeliveryError(`The Sentry API request was refused: ${sdk.message}`, { permanent: true });
    throw new PluginDeliveryError(`Sentry could not be reached: ${sdk ? sdk.message : 'the request failed'}`);
  }
  if (status === 429) throw new SentryApiError('RATE_LIMITED', false, parsePluginRetryAfter(retryAfter));
  if (status >= 500 || status === 408) throw new SentryApiError(`HTTP_${status}`, false, parsePluginRetryAfter(retryAfter));
  if (status < 200 || status >= 300) throw new SentryApiError(CODES[status] ?? `HTTP_${status}`, true);
  if (!text.trim()) return null;
  try { return JSON.parse(text) as T; } catch { throw new SentryApiError('NOT_JSON', false); }
}

/** A `SentryApiError` (or any other error) as the delivery's failure. */
export function deliveryFailure(error: unknown, what: string): Error {
  if (!(error instanceof SentryApiError)) return error instanceof Error ? error : new Error(String(error));
  if (!error.permanent) {
    const wait = error.retryAfterMs === null ? '' : `; it asked to retry after ${Math.max(1, Math.ceil(error.retryAfterMs / 1000))} s`;
    return new PluginDeliveryError(`Sentry answered ${error.code} for ${what}${wait}`, { retryAfterMs: error.retryAfterMs });
  }
  const hint = error.code === 'UNAUTHORIZED'
    ? 'Check the internal integration token under Connections'
    : 'Check the organization slug and that the integration has Project: Read and Issue & Event: Read & Write';
  return new PluginDeliveryError(`Sentry refused ${what} with ${error.code}; it is not retried. ${hint}`, { permanent: true });
}

const issuePath = (ctx: PluginContext, id: string) => {
  if (!ISSUE_ID.test(id)) throw new SentryApiError('INVALID_ISSUE_ID', true);
  return `organizations/${sentryOrganization(ctx.settings)}/issues/${id}/`;
};

export interface SentryIssue {
  id?: unknown; shortId?: unknown; title?: unknown; culprit?: unknown; level?: unknown; status?: unknown;
  count?: unknown; firstSeen?: unknown; lastSeen?: unknown;
  project?: { id?: unknown; slug?: unknown } | null;
}

export interface SentryEvent {
  eventID?: unknown; dateCreated?: unknown; environment?: unknown;
  tags?: unknown;
  entries?: unknown;
}

/** The issue as Sentry has it now. */
export async function getIssue(ctx: PluginContext, id: string): Promise<SentryIssue> {
  const issue = await sentryRequest<SentryIssue>(ctx, 'GET', issuePath(ctx, id));
  if (!issue || typeof issue !== 'object') throw new SentryApiError('NOT_FOUND', true);
  return issue;
}

/** The issue's latest event, or null when Sentry has none. */
export async function getLatestEvent(ctx: PluginContext, id: string): Promise<SentryEvent | null> {
  try {
    const event = await sentryRequest<SentryEvent>(ctx, 'GET', `${issuePath(ctx, id)}events/latest/`);
    return event && typeof event === 'object' ? event : null;
  } catch (error) {
    if (error instanceof SentryApiError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/** A note on the issue's activity. `text` is ProPR's own sentence and a link. */
export async function addNote(ctx: PluginContext, id: string, text: string): Promise<void> {
  await sentryRequest(ctx, 'POST', `${issuePath(ctx, id)}notes/`, { text });
}

/** Mark the issue resolved. */
export async function resolveIssue(ctx: PluginContext, id: string): Promise<void> {
  await sentryRequest(ctx, 'PUT', issuePath(ctx, id), { status: 'resolved' });
}

export interface SentryProject { id: string; slug: string; name: string }

/** The organization's projects (the first page, up to 100). */
export async function listProjects(ctx: PluginContext): Promise<SentryProject[]> {
  const organization = sentryOrganization(ctx.settings);
  if (!organization) throw new PluginDeliveryError(NOT_CONNECTED, { permanent: true });
  const list = await sentryRequest<unknown>(ctx, 'GET', `organizations/${organization}/projects/?per_page=100`);
  return (Array.isArray(list) ? list as Partial<SentryProject>[] : [])
    .filter((p): p is SentryProject => typeof p?.id === 'string' && typeof p.slug === 'string' && typeof p.name === 'string');
}
