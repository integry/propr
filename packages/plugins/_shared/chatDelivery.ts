import {
  PLUGIN_CONNECTION_URL, PLUGIN_REPOSITORY_PATTERN, PluginDeliveryError, PluginSdkError, parsePluginRetryAfter,
  type PluginContext, type PluginEventInput, type PluginJsonValue, type PluginSettingValues,
} from '@propr/shared';
import { eventName } from './eventSelection.js';
import { NOTIFICATION_SETTINGS, buildNotification, type Notification } from './notifications.js';

/**
 * Destination resolution and delivery shared by the chat notification
 * plugins. A destination is one of the plugin's webhook URL connections (a
 * `token` connection with `secretUrl`): the default one, or the one the
 * `repositoryDestinations` map names for the event's repository. The handler
 * never sees a URL: it posts to `PLUGIN_CONNECTION_URL` through the
 * connection.
 */

/** The value of `repositoryDestinations` that sends nothing for a repository. */
export const MUTED_DESTINATION = 'none';

/** A chat service as the shared delivery sees it. */
export interface ChatService {
  /** The service's name in messages, such as `Slack`. */
  name: string;
  /** The webhook URL connections, the default first. */
  destinations: readonly { connection: string; label: string }[];
  /** The request body of a notification, in the service's format. */
  render(notification: Notification): PluginJsonValue;
  /**
   * A short reason from an error response for the failure message, or null.
   * Only a service's own coded reason (such as Slack's `channel_not_found`)
   * is returned; it is never more than one short line.
   */
  errorDetail?(status: number, body: string): string | null;
  /** A retry delay (ms) from an error response body, for a service that puts it there (Discord's `retry_after`). */
  retryAfterFromBody?(body: string): number | null;
}

export type Destination = { connection: string; label: string };
export type DestinationResolution = { destination: Destination } | { muted: true } | { problem: string };

/**
 * The destination of `repository`: its entry in `repositoryDestinations`
 * (keys compared without letter case; the value a connection name or `none`),
 * otherwise the default destination.
 */
export function resolveDestination(service: Pick<ChatService, 'destinations'>, settings: PluginSettingValues, repository: string): DestinationResolution {
  const map = settings[NOTIFICATION_SETTINGS.repositoryDestinations];
  const name = repository.toLowerCase();
  const entry = map && typeof map === 'object' && !Array.isArray(map)
    ? Object.entries(map).find(([key]) => key.toLowerCase() === name)?.[1]
    : undefined;
  const fallback = service.destinations[0];
  if (entry === undefined || entry.trim() === '') return { destination: fallback };
  const value = entry.trim().toLowerCase();
  if (value === MUTED_DESTINATION) return { muted: true };
  const destination = service.destinations.find(d => d.connection === value);
  if (destination) return { destination };
  const choices = [...service.destinations.map(d => d.connection), MUTED_DESTINATION].join(', ');
  // The setting value is the administrator's text: only a coded value is repeated.
  const shown = /^[a-z0-9_-]{1,48}$/.test(value) ? ` ${value},` : '';
  return { problem: `Repository destinations map ${PLUGIN_REPOSITORY_PATTERN.test(repository) ? repository : 'a repository'} to${shown} which is not one of ${choices}` };
}

/** `ctx.http` refusals that are configuration problems: retrying cannot help. */
const PERMANENT_SDK_CODES = new Set(['host_not_allowed', 'insecure_url', 'private_address', 'invalid_input', 'connection_unavailable', 'permission_denied']);
/** Statuses that may succeed later: timeouts, rate limits and server errors. Every other non-2xx status is permanent. */
const transientStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

export interface ChatDeliveryResult { [key: string]: PluginJsonValue; event: string; kind: string | null; destination: string | null; skipped: string | null }

/**
 * Post one subscribed event to its destination, or nothing when the `events`
 * setting does not select it or its repository is muted. A rate limit or a
 * server error is retried after the service's `Retry-After` (or the delay in
 * its body) when it gives one; any other refusal, an unset or refused
 * webhook URL, or a bad destination map marks the delivery failed with a
 * readable message.
 */
export async function deliverChatNotification(service: ChatService, input: PluginEventInput, ctx: PluginContext): Promise<ChatDeliveryResult> {
  const { event } = input;
  const name = eventName(event);
  const notification = buildNotification(event, ctx.settings);
  if (!notification) return { event: name, kind: null, destination: null, skipped: 'not_selected' };
  const resolution = resolveDestination(service, ctx.settings, event.repository);
  if ('muted' in resolution) return { event: name, kind: notification.kind, destination: null, skipped: 'muted' };
  if ('problem' in resolution) throw new PluginDeliveryError(`${resolution.problem}. Fix the plugin's settings`, { permanent: true });
  const { destination } = resolution;
  const body = JSON.stringify(service.render(notification));

  let status: number; let retryAfter: string | undefined; let text = '';
  try {
    const response = await ctx.http(destination.connection)(PLUGIN_CONNECTION_URL, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    status = response.status; retryAfter = response.headers['retry-after'];
    if (!response.ok) text = (await response.text()).slice(0, 2_000);
  } catch (error) {
    const sdk = error instanceof PluginSdkError ? error : null;
    if (sdk?.code === 'connection_unavailable') {
      throw new PluginDeliveryError(`The ${service.name} webhook URL of ${destination.label} is not set. Set it under Connections`, { permanent: true });
    }
    if (sdk && PERMANENT_SDK_CODES.has(sdk.code)) {
      throw new PluginDeliveryError(`The message was not sent to ${destination.label}: ${sdk.message}. Check its ${service.name} webhook URL`, { permanent: true });
    }
    throw new PluginDeliveryError(`${service.name} could not be reached for ${destination.label}: ${sdk ? sdk.message : 'the request failed'}`);
  }
  if (status >= 200 && status < 300) {
    ctx.log.info(`Posted ${notification.kind} to ${destination.label}`, { destination: destination.connection, status });
    return { event: name, kind: notification.kind, destination: destination.connection, skipped: null };
  }
  const detail = service.errorDetail?.(status, text) ?? null;
  const reason = `HTTP ${status}${detail ? ` (${detail})` : ''}`;
  if (transientStatus(status)) {
    const retryAfterMs = parsePluginRetryAfter(retryAfter) ?? (status === 429 ? service.retryAfterFromBody?.(text) ?? null : null);
    const wait = retryAfterMs === null ? '' : `; it asked to retry after ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s`;
    throw new PluginDeliveryError(`${service.name} answered ${reason} for ${destination.label}${wait}`, { retryAfterMs });
  }
  throw new PluginDeliveryError(`${service.name} refused the message to ${destination.label} with ${reason}; it is not retried. Check its webhook URL and that the channel still exists`, { permanent: true });
}
