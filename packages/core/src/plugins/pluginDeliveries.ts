import type { Knex } from 'knex';
import {
  PLUGIN_ACTIVITY_LIMIT, PLUGIN_DEGRADED_AFTER_FAILURES, PLUGIN_DELIVERY_RETENTION_DAYS, PLUGIN_LOG_LIMITS, PLUGIN_PAUSE_AFTER_FAILURES,
  type PluginActivity, type PluginAuditAction, type PluginDeliveryKind, type PluginDeliveryStatus, type PluginDeliveryView, type PluginHealthView, type PluginLogLine,
} from '@propr/shared';
import logger from '../utils/logger.js';
import { PluginError } from './pluginState.js';

/**
 * Activity records of plugin event deliveries (`plugin_deliveries`) and the
 * delivery health of each installation (`plugin_dispatch`). A record holds
 * the event's `seq` and type, the handler, the outcome, timing, the attempt
 * count and the latest attempt's redacted error and log lines: never the
 * event payload, a handler result or a credential.
 */

/** A `plugin_dispatch` row as stored. */
export interface PluginDispatchRow {
  plugin_id: string; installed_at: number | string; start_seq: number | string;
  lease_owner: string | null; lease_expires_at: number | string | null;
  consecutive_failures: number; last_error: string | null; last_error_at: number | string | null;
  degraded_at: number | string | null; paused_at: number | string | null; updated_at: number | string;
  /** The Degraded notification still owed (a `PluginDegradedNotice` as JSON), or null. */
  degraded_notice?: string | null;
}
/** A `plugin_deliveries` row as stored. */
export interface PluginDeliveryRow {
  id: number; plugin_id: string; delivery_id: string; kind: PluginDeliveryKind; repository: string; event_seq: number | string;
  event_type: string | null; handler: string | null; status: PluginDeliveryStatus; attempt: number; manual: number | boolean; next_attempt_at: number | string | null;
  created_at: number | string; started_at: number | string | null; finished_at: number | string | null; duration_ms: number | null;
  timed_out: number | boolean; error: string | null; logs: string;
}

/** Log lines kept per delivery record, and their serialized size. */
const STORED_LOG_LINES = 100;
const STORED_LOG_BYTES = 64 * 1024;
const ERROR_CHARS = 1_000;

const num = (value: number | string | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));

/** The stable id of one event's delivery to one handler; handlers de-duplicate on it. */
export const pluginDeliveryId = (seq: number, handler: string) => `evt-${seq}-${handler}`;

/** Consecutive failed attempts that pause deliveries: `PROPR_PLUGIN_PAUSE_AFTER_FAILURES`, at least the Degraded threshold. */
export function pluginPauseAfterFailures(environment: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(environment.PROPR_PLUGIN_PAUSE_AFTER_FAILURES ?? '', 10);
  return Number.isSafeInteger(value) && value >= PLUGIN_DEGRADED_AFTER_FAILURES ? value : PLUGIN_PAUSE_AFTER_FAILURES;
}

/** Log lines as stored: at most `STORED_LOG_LINES` lines and `STORED_LOG_BYTES`, with a marker when lines were dropped. */
export function storedLogs(logs: readonly PluginLogLine[]): string {
  const kept: PluginLogLine[] = [];
  let bytes = 2;
  for (const line of logs.slice(0, STORED_LOG_LINES)) {
    const size = Buffer.byteLength(JSON.stringify(line)) + 1;
    if (bytes + size > STORED_LOG_BYTES) break;
    kept.push(line); bytes += size;
  }
  if (kept.length < logs.length) kept.push({ level: 'warn', message: `${logs.length - kept.length} more log lines were not kept`, at: kept.at(-1)?.at ?? 0 });
  return JSON.stringify(kept);
}

export const clipError = (error: string | null) => (error === null ? null : error.slice(0, ERROR_CHARS));

function parseLogs(text: string): PluginLogLine[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((line): line is PluginLogLine => Boolean(line) && typeof line === 'object' && typeof (line as PluginLogLine).message === 'string')
      .map(line => ({ ...line, message: line.message.slice(0, PLUGIN_LOG_LIMITS.messageChars) })) : [];
  } catch { return []; }
}

export function deliveryView(row: PluginDeliveryRow): PluginDeliveryView {
  return {
    id: Number(row.id), deliveryId: row.delivery_id, kind: row.kind, repository: row.repository, eventSeq: Number(row.event_seq),
    eventType: row.event_type, handler: row.handler, status: row.status, attempt: Number(row.attempt),
    nextAttemptAt: row.status === 'pending' || row.status === 'retrying' ? num(row.next_attempt_at) : null,
    createdAt: Number(row.created_at), startedAt: num(row.started_at), finishedAt: num(row.finished_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms), timedOut: Boolean(row.timed_out),
    error: row.error, logs: parseLogs(row.logs),
  };
}

export function healthView(row: PluginDispatchRow | undefined, pauseAfterFailures: number): PluginHealthView {
  const failures = Number(row?.consecutive_failures ?? 0);
  const pausedAt = num(row?.paused_at);
  const degradedAt = num(row?.degraded_at);
  return {
    state: pausedAt !== null ? 'paused' : degradedAt !== null ? 'degraded' : 'healthy',
    consecutiveFailures: failures, pauseAfterFailures,
    lastError: row?.last_error ?? null, lastErrorAt: num(row?.last_error_at), degradedAt, pausedAt,
  };
}

// eslint-disable-next-line max-params -- the transaction, plugin, action, actor, time and detail are explicit audit inputs
const audit = (trx: Knex, pluginId: string, action: PluginAuditAction, actor: string, at: number, detail: Record<string, unknown>) =>
  trx('plugin_audit').insert({ plugin_id: pluginId, action, actor, at, detail: JSON.stringify(detail) });

const installedAtOf = async (database: Knex, pluginId: string): Promise<number> => {
  const row = await database('plugin_installations').where({ plugin_id: pluginId }).first('installed_at') as { installed_at: number | string } | undefined;
  if (!row) throw new PluginError(404, 'The plugin is not installed');
  return Number(row.installed_at);
};
/** The dispatch row of the installation as it is now; a row left by an earlier installation does not count. */
async function currentDispatch(database: Knex, pluginId: string): Promise<PluginDispatchRow | undefined> {
  const installedAt = await installedAtOf(database, pluginId);
  const row = await database('plugin_dispatch').where({ plugin_id: pluginId }).first() as PluginDispatchRow | undefined;
  return row && Number(row.installed_at) === installedAt ? row : undefined;
}

/** The installation's delivery health and its newest delivery records, newest first. */
export async function listPluginActivity(database: Knex, pluginId: string, options: { limit?: number; environment?: NodeJS.ProcessEnv } = {}): Promise<PluginActivity> {
  const row = await currentDispatch(database, pluginId);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? PLUGIN_ACTIVITY_LIMIT), 1), PLUGIN_ACTIVITY_LIMIT);
  const rows = await database('plugin_deliveries').where({ plugin_id: pluginId }).orderBy('id', 'desc').limit(limit).select() as PluginDeliveryRow[];
  return { health: healthView(row, pluginPauseAfterFailures(options.environment)), deliveries: rows.map(deliveryView) };
}

/**
 * Retry a failed delivery: it gets one more attempt as soon as the dispatcher
 * runs (after a Resume while deliveries are paused). The event is read from
 * the journal again; the delivery id stays the same.
 */
// eslint-disable-next-line max-params -- the database, plugin, record id, actor and time are explicit inputs
export async function retryPluginDelivery(database: Knex, pluginId: string, id: unknown, actor: string, now: number = Date.now()): Promise<PluginDeliveryView> {
  const recordId = typeof id === 'string' && /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
  if (recordId === null) throw new PluginError(400, 'Invalid delivery id');
  return database.transaction(async trx => {
    await installedAtOf(trx, pluginId);
    const row = await trx('plugin_deliveries').where({ plugin_id: pluginId, id: recordId }).first() as PluginDeliveryRow | undefined;
    if (!row) throw new PluginError(404, 'Delivery not found');
    if (row.kind !== 'event' || row.status !== 'failed') throw new PluginError(409, 'Only a failed event delivery can be retried');
    // A manual retry: one attempt, then final; `manual` lets a dispatcher recover it after a crash mid-attempt.
    await trx('plugin_deliveries').where({ id: recordId, status: 'failed' }).update({ status: 'pending', manual: true, next_attempt_at: now });
    await audit(trx, pluginId, 'retry_delivery', actor, now, { deliveryId: row.delivery_id, eventSeq: Number(row.event_seq), handler: row.handler });
    return deliveryView({ ...row, status: 'pending', next_attempt_at: now });
  });
}

/** Resume paused deliveries: the failure count starts over, Degraded clears and waiting retries are due now. */
export async function resumePluginDeliveries(database: Knex, pluginId: string, actor: string, options: { now?: number; environment?: NodeJS.ProcessEnv } = {}): Promise<PluginHealthView> {
  const now = options.now ?? Date.now();
  return database.transaction(async trx => {
    const row = await currentDispatch(trx, pluginId);
    if (!row || row.paused_at === null) throw new PluginError(409, 'Deliveries of this plugin are not paused');
    const update = { paused_at: null, degraded_at: null, consecutive_failures: 0, updated_at: now };
    await trx('plugin_dispatch').where({ plugin_id: pluginId }).update(update);
    await trx('plugin_deliveries').where({ plugin_id: pluginId, status: 'retrying' }).update({ next_attempt_at: now });
    await audit(trx, pluginId, 'resume_deliveries', actor, now, { consecutiveFailures: Number(row.consecutive_failures), lastError: row.last_error });
    return healthView({ ...row, ...update }, pluginPauseAfterFailures(options.environment));
  });
}

/** The highest journal `seq` ever handed out: where a new subscription starts. */
export async function journalHead(database: Knex): Promise<number> {
  const max = await database('repository_events').max({ seq: 'seq' }).first() as { seq: number | null } | undefined;
  let sequence = 0;
  try {
    const rows = await database.raw("SELECT seq FROM sqlite_sequence WHERE name = 'repository_events'") as Array<{ seq: number }>;
    sequence = Number(rows[0]?.seq ?? 0);
  } catch { /* no AUTOINCREMENT bookkeeping */ }
  return Math.max(Number(max?.seq ?? 0), sequence);
}

/**
 * Start the installation's subscriptions at the journal's current end: on
 * install and when it is enabled again. Nothing earlier is delivered, so
 * history is never replayed. Delivery records and health start over.
 */
export async function restartPluginDispatch(trx: Knex, pluginId: string, installedAt: number, now: number): Promise<void> {
  const start = await journalHead(trx);
  await trx('plugin_delivery_cursors').where({ plugin_id: pluginId }).delete();
  await trx('plugin_dispatch').insert({
    plugin_id: pluginId, installed_at: installedAt, start_seq: start, lease_owner: null, lease_expires_at: null,
    consecutive_failures: 0, last_error: null, last_error_at: null, degraded_at: null, paused_at: null, updated_at: now,
  }).onConflict('plugin_id').merge();
  // A Degraded notification still owed (`degraded_notice`, not merged) is kept: it is sent once it can be.
  // Deliveries that never finished would otherwise run after the restart: they belong to before it.
  await trx('plugin_deliveries').where({ plugin_id: pluginId }).whereIn('status', ['pending', 'running', 'retrying'])
    .update({ status: 'failed', manual: false, next_attempt_at: null, error: 'Not delivered: the plugin was disabled' });
}

/** Delete the dispatch state and delivery records of an installation (uninstall). */
export async function deletePluginDispatch(trx: Knex, pluginId: string): Promise<number> {
  await trx('plugin_dispatch').where({ plugin_id: pluginId }).delete();
  await trx('plugin_delivery_cursors').where({ plugin_id: pluginId }).delete();
  return trx('plugin_deliveries').where({ plugin_id: pluginId }).delete();
}

/**
 * Delete final delivery records older than the retention period. A record of
 * an event still in the journal and ahead of its repository's cursor (the
 * cursor of the lower-cased name, or the installation's start before one
 * exists) is kept: the event is read again (a handler after it is retrying,
 * or deliveries are paused), and the record is what makes a handler that
 * already succeeded or failed for good not run again with its attempts reset.
 */
export async function prunePluginDeliveries(database: Knex, options: { olderThanDays?: number; now?: () => number } = {}): Promise<number> {
  const cutoff = (options.now ?? Date.now)() - (options.olderThanDays ?? PLUGIN_DELIVERY_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  return database('plugin_deliveries').where('created_at', '<', cutoff).whereIn('status', ['succeeded', 'failed', 'skipped'])
    .whereNot(needed => {
      void needed.where('plugin_deliveries.kind', 'event')
        .whereExists(q => { void q.select(1).from('repository_events as e').whereRaw('?? = ??', ['e.seq', 'plugin_deliveries.event_seq']); })
        .whereExists(q => {
          void q.select(1).from('plugin_dispatch as d').whereRaw('?? = ??', ['d.plugin_id', 'plugin_deliveries.plugin_id'])
            .whereRaw('?? > COALESCE((SELECT ?? FROM ?? AS c WHERE ?? = ?? AND ?? = lower(??)), ??)', [
              'plugin_deliveries.event_seq', 'c.cursor_seq', 'plugin_delivery_cursors', 'c.plugin_id', 'plugin_deliveries.plugin_id',
              'c.repository', 'plugin_deliveries.repository', 'd.start_seq',
            ]);
        });
    })
    .delete();
}

export interface PluginDegradedNotice { pluginId: string; installedAt: number; degradedAt: number; consecutiveFailures: number; lastError: string | null }
export type PluginDegradedNotifier = (notice: PluginDegradedNotice) => Promise<void>;

/** One Inbox notification to every durable administrator when an installation becomes Degraded. */
export function notifyAdministratorsOfDegradedPlugin(database: Knex): PluginDegradedNotifier {
  return async ({ pluginId, installedAt, degradedAt, consecutiveFailures, lastError }) => {
    const rows = await database('instance_members').distinct('github_user_id').where({ role: 'admin' }) as { github_user_id?: unknown }[];
    const recipients = rows.flatMap(row => (typeof row.github_user_id === 'string' ? [{ userId: row.github_user_id, pushEnabled: true }] : []));
    if (!recipients.length) return;
    const { createNotificationEvent } = await import('../services/notificationService.js');
    await createNotificationEvent({
      deduplicationKey: `plugin-degraded:${pluginId}:${installedAt}:${degradedAt}`,
      kind: 'system_failure', severity: 'warning',
      target: { type: 'system_failure', component: 'plugins.dispatcher', correlationId: pluginId },
      title: `Plugin ${pluginId} is degraded`,
      body: `${consecutiveFailures} event deliveries to plugin ${pluginId} failed in a row.${lastError ? ` Last error: ${lastError.slice(0, 300)}` : ''} See its Activity on the Plugins page.`,
      actions: ['dismiss'], metadata: { plugin: pluginId },
    }, recipients);
  };
}

/** Run a notifier without letting it fail the caller; whether it succeeded. */
export async function notifySafely(notify: PluginDegradedNotifier, notice: PluginDegradedNotice): Promise<boolean> {
  try { await notify(notice); return true; } catch (error) {
    logger.warn({ pluginId: notice.pluginId, error: error instanceof Error ? error.message : String(error) }, '[plugins] Could not notify administrators of a degraded plugin');
    return false;
  }
}

function parseNotice(text: string): PluginDegradedNotice | null {
  try {
    const value = JSON.parse(text) as Partial<PluginDegradedNotice> | null;
    return value && typeof value.pluginId === 'string' && typeof value.installedAt === 'number' && typeof value.degradedAt === 'number' ? value as PluginDegradedNotice : null;
  } catch { return null; }
}

/**
 * Send the Degraded notifications still owed (`degraded_notice`, written in
 * the transaction that made the installation Degraded). Each is cleared only
 * once its notifier succeeded, and only if it is still the same notice, so a
 * failed or interrupted send is tried again; the notification's
 * deduplication key keeps a repeat, or two dispatchers sending it, to one
 * Inbox entry. Returns whether every one went out.
 */
export async function sendPendingDegradedNotices(database: Knex, notify: PluginDegradedNotifier, pluginId?: string): Promise<boolean> {
  const rows = await database('plugin_dispatch').whereNotNull('degraded_notice').modify(q => { if (pluginId) void q.where({ plugin_id: pluginId }); })
    .select('plugin_id', 'degraded_notice') as { plugin_id: string; degraded_notice: string }[];
  let sent = true;
  for (const row of rows) {
    const notice = parseNotice(row.degraded_notice);
    if (notice && !await notifySafely(notify, notice)) { sent = false; continue; }
    await database('plugin_dispatch').where({ plugin_id: row.plugin_id, degraded_notice: row.degraded_notice }).update({ degraded_notice: null });
  }
  return sent;
}
