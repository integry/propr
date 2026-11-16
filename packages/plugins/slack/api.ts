import { PluginDeliveryError, PluginSdkError, parsePluginRetryAfter, type PluginContext, type PluginJsonValue } from '@propr/shared';

/**
 * The Slack Web API calls of app mode, through `ctx.http('bot-token')`: ProPR
 * injects the bot token as `Authorization: Bearer` and only `slack.com` is
 * reachable. Slack answers most errors with HTTP 200 and `{ ok: false, error }`;
 * a rate limit is HTTP 429 with `Retry-After`. See
 * https://docs.slack.dev/apis/web-api/ and
 * https://docs.slack.dev/apis/web-api/rate-limits.
 */

export const BOT_TOKEN = 'bot-token';
export const SLACK_API = 'https://slack.com/api';

/** Slack error codes that may succeed later; every other code is permanent. */
const TRANSIENT_CODES = new Set(['ratelimited', 'rate_limited', 'fatal_error', 'internal_error', 'service_unavailable', 'request_timeout']);
/** `ctx.http` refusals that are configuration problems: retrying cannot help. */
const PERMANENT_SDK_CODES = new Set(['host_not_allowed', 'insecure_url', 'private_address', 'invalid_input', 'connection_unavailable', 'permission_denied']);
/** A Slack error code: lower-case letters and `_`. Anything else is not repeated. */
const code = (value: unknown): string | null => (typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : null);

export type SlackOk = { ok: true } & Record<string, unknown>;
/** A Slack refusal the caller may handle (such as `thread_not_found`); thrown as `SlackApiError`. */
export class SlackApiError extends Error {
  readonly name = 'SlackApiError';
  constructor(readonly code: string, readonly permanent: boolean, readonly retryAfterMs: number | null = null) { super(`Slack answered ${code}`); }
}

/**
 * One Web API call. GET methods take `query`, POST methods a JSON body.
 * Throws `SlackApiError` for Slack's answers and `PluginDeliveryError` when
 * Slack cannot be reached or the bot token is not set.
 */
export async function slackApi(ctx: PluginContext, method: string, init: { query?: Record<string, string>; json?: PluginJsonValue }): Promise<SlackOk> {
  const url = `${SLACK_API}/${method}${init.query ? `?${new URLSearchParams(init.query).toString()}` : ''}`;
  let status: number; let retryAfter: string | undefined; let text: string;
  try {
    const response = await ctx.http(BOT_TOKEN)(url, init.json === undefined
      ? { method: 'GET' }
      : { method: 'POST', json: init.json, headers: { 'content-type': 'application/json; charset=utf-8' } });
    status = response.status; retryAfter = response.headers['retry-after'];
    text = (await response.text()).slice(0, 64_000);
  } catch (error) {
    const sdk = error instanceof PluginSdkError ? error : null;
    if (sdk?.code === 'connection_unavailable') throw new PluginDeliveryError('The Slack bot token is not set. Set Bot token (app mode) under Connections', { permanent: true });
    if (sdk && PERMANENT_SDK_CODES.has(sdk.code)) throw new PluginDeliveryError(`The Slack ${method} call was refused: ${sdk.message}`, { permanent: true });
    throw new PluginDeliveryError(`Slack could not be reached for ${method}: ${sdk ? sdk.message : 'the request failed'}`);
  }
  if (status === 429) throw new SlackApiError('ratelimited', false, parsePluginRetryAfter(retryAfter));
  if (status >= 500 || status === 408) throw new SlackApiError(`http_${status}`, false, parsePluginRetryAfter(retryAfter));
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = null; }
  if (status >= 200 && status < 300 && body?.ok === true) return body as SlackOk;
  const reason = code(body?.error) ?? `http_${status}`;
  throw new SlackApiError(reason, !TRANSIENT_CODES.has(reason), parsePluginRetryAfter(retryAfter));
}

/** A `SlackApiError` (or any other error) as the delivery's failure. */
export function deliveryFailure(error: unknown, what: string): Error {
  if (!(error instanceof SlackApiError)) return error instanceof Error ? error : new Error(String(error));
  if (!error.permanent) {
    const wait = error.retryAfterMs === null ? '' : `; it asked to retry after ${Math.max(1, Math.ceil(error.retryAfterMs / 1000))} s`;
    return new PluginDeliveryError(`Slack answered ${error.code} for ${what}${wait}`, { retryAfterMs: error.retryAfterMs });
  }
  return new PluginDeliveryError(`Slack refused ${what} with ${error.code}; it is not retried. Check the bot token, its scopes and that the bot is in the channel`, { permanent: true });
}

export interface PostedMessage { channel: string; ts: string }

/** `chat.postMessage` (scope `chat:write`): a message, in the thread of `threadTs` when given. Links and media are not unfurled. */
export async function postMessage(ctx: PluginContext, channel: string, message: { text: string; blocks?: PluginJsonValue }, threadTs?: string): Promise<PostedMessage> {
  const json: Record<string, PluginJsonValue> = { channel, text: message.text, unfurl_links: false, unfurl_media: false };
  if (message.blocks !== undefined) json.blocks = message.blocks;
  if (threadTs) json.thread_ts = threadTs;
  const answer = await slackApi(ctx, 'chat.postMessage', { json });
  return { channel: typeof answer.channel === 'string' ? answer.channel : channel, ts: typeof answer.ts === 'string' ? answer.ts : '' };
}

/** `chat.getPermalink` (no scope): the message's link, or null when Slack does not give one. */
export async function permalink(ctx: PluginContext, channel: string, ts: string): Promise<string | null> {
  try {
    const answer = await slackApi(ctx, 'chat.getPermalink', { query: { channel, message_ts: ts } });
    return typeof answer.permalink === 'string' && /^https:\/\/[a-z0-9.-]+\.slack(-gov)?\.com\//i.test(answer.permalink) ? answer.permalink : null;
  } catch (error) {
    if (error instanceof PluginDeliveryError && error.permanent) throw error;
    return null;
  }
}

/** `usergroups.users.list` (scope `usergroups:read`): the member ids of a user group. */
export async function userGroupMembers(ctx: PluginContext, userGroup: string): Promise<string[]> {
  const answer = await slackApi(ctx, 'usergroups.users.list', { query: { usergroup: userGroup } });
  return Array.isArray(answer.users) ? answer.users.filter((u): u is string => typeof u === 'string') : [];
}
