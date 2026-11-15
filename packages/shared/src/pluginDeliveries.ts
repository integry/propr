import type { PluginLogLine } from './pluginSdk.js';

/**
 * Event deliveries to plugin handlers and an installation's delivery health,
 * as the Plugins page and API show them. A delivery record holds the event id
 * (`seq`) and type only: never the event payload, and never a credential.
 */

/** Waits before the 2nd, 3rd, 4th and 5th attempt of a failing delivery; after the last attempt it is marked failed. */
export const PLUGIN_DELIVERY_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
/** Delivery records are kept this long. */
export const PLUGIN_DELIVERY_RETENTION_DAYS = 14;
/** Consecutive failed attempts after which an installation is shown as Degraded (and administrators are notified once). */
export const PLUGIN_DEGRADED_AFTER_FAILURES = 3;
/** Default number of consecutive failed attempts after which deliveries pause until an administrator resumes them. */
export const PLUGIN_PAUSE_AFTER_FAILURES = 10;
/** Delivery records one activity read returns at most. */
export const PLUGIN_ACTIVITY_LIMIT = 100;

/**
 * `pending`: waiting for its first attempt. `running`: an attempt is under way.
 * `retrying`: an attempt failed and the next one is scheduled. `succeeded`,
 * `failed` (retries exhausted, or a manual retry failed) and `skipped` (a gap:
 * events that left the journal before they could be delivered) are final.
 */
export const PLUGIN_DELIVERY_STATUSES = ['pending', 'running', 'retrying', 'succeeded', 'failed', 'skipped'] as const;
export type PluginDeliveryStatus = typeof PLUGIN_DELIVERY_STATUSES[number];
/**
 * `event`: one journal event to one handler. `gap`: journal retention removed
 * events before they were delivered. `webhook`: one verified inbound webhook
 * request to its handler (its body is held in memory only, never stored).
 */
export const PLUGIN_DELIVERY_KINDS = ['event', 'gap', 'webhook'] as const;
export type PluginDeliveryKind = typeof PLUGIN_DELIVERY_KINDS[number];

export interface PluginDeliveryView {
  /** The activity record id, used by the retry route. */
  id: number;
  /** The stable delivery id handlers receive (`evt-<seq>-<handler>`, `whk-<webhook>:<id>`, `whk-<webhook>/<uuid>`); the same on every attempt. */
  deliveryId: string;
  kind: PluginDeliveryKind;
  /** The event's repository; empty for a webhook delivery. */
  repository: string;
  /** The journal `seq` of the event; for a gap, the first `seq` that may be missing; 0 for a webhook. */
  eventSeq: number;
  /** `<domain>.<type>`; `webhook.<name>` for a webhook delivery; null for a gap. */
  eventType: string | null;
  handler: string | null;
  status: PluginDeliveryStatus;
  /** Attempts made so far. */
  attempt: number;
  /** When the next attempt is due, while `pending` or `retrying`. */
  nextAttemptAt: number | null;
  /** When the delivery was recorded. */
  createdAt: number;
  /** When the latest attempt started and finished. */
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  timedOut: boolean;
  /** The latest attempt's redacted error message. */
  error: string | null;
  /** The latest attempt's redacted log lines. */
  logs: PluginLogLine[];
}

/** `healthy`; `degraded`: repeated failures; `paused`: deliveries stopped until an administrator resumes them. */
export const PLUGIN_HEALTH_STATES = ['healthy', 'degraded', 'paused'] as const;
export type PluginHealthState = typeof PLUGIN_HEALTH_STATES[number];

export interface PluginHealthView {
  state: PluginHealthState;
  consecutiveFailures: number;
  /** Consecutive failed attempts that pause deliveries. */
  pauseAfterFailures: number;
  lastError: string | null;
  lastErrorAt: number | null;
  degradedAt: number | null;
  pausedAt: number | null;
}

export interface PluginActivity { health: PluginHealthView; deliveries: PluginDeliveryView[] }
