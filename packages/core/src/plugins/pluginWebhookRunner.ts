import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { PLUGIN_DELIVERY_RETRY_DELAYS_MS, PLUGIN_WEBHOOK_LIMITS, type PluginHandlerRun, type PluginLogLine, type PluginWebhookInput } from '@propr/shared';
import logger from '../utils/logger.js';
import { runPluginHandler, type RunPluginHandlerOptions } from './pluginHandlerRunner.js';
import { installationRecord, type PluginInstallationRow } from './pluginState.js';
import { storedLogs, type PluginDeliveryRow } from './pluginDeliveries.js';
import type { PluginInstallationTarget } from './pluginContext.js';

/**
 * Runs verified inbound webhook requests through their handlers, as
 * deliveries of kind `webhook` recorded in the plugin's Activity like event
 * deliveries, with the same retry schedule (1 min, 5 min, 30 min, 2 h, then
 * failed).
 *
 * The request (body and headers) is held in this process's memory only, never
 * written anywhere: the delivery record carries the webhook and handler
 * names, the delivery id, status and timing. The handler's error and log
 * messages are not kept either, since a handler may log or throw any part of
 * the request: only each log line's level and time, and whether the attempt
 * failed or timed out (see `webhookDiagnostics`).
 *
 * Each delivery record names the runner holding its request
 * (`webhook_owner`), and each runner keeps a heartbeat in
 * `plugin_webhook_runners`. A delivery whose owner stopped cannot be resumed
 * by another process: once the owner's heartbeat has lapsed, any runner marks
 * it failed. A live runner's deliveries are never touched by another.
 *
 * A delivery stays this runner's obligation until its database transition
 * succeeds: a failed write (a transient database error) is retried on
 * `persistRetryMs`, without running the handler again, and a reservation is
 * kept until its record is given back or answered. A record of this runner's
 * that it no longer holds (nor reserved) is marked failed with the next
 * heartbeat.
 */
export interface PluginWebhookRunnerOptions extends Omit<RunPluginHandlerOptions, 'database'> {
  database: Knex;
  retryDelaysMs?: readonly number[];
  /** This runner's owner name; unique per process by default. */
  owner?: string;
  /** Interval between heartbeats (and recoveries of deliveries whose owner stopped). */
  heartbeatMs?: number;
  /** A runner whose heartbeat is older than this is taken to have stopped. */
  ownerTtlMs?: number;
  /** Deliveries held in memory at once; further requests are refused (503) until some finish. */
  maxPending?: number;
  /** Delays between retries of a database write that failed; the last repeats. */
  persistRetryMs?: readonly number[];
  run?: typeof runPluginHandler;
}

export interface PluginWebhookJob {
  target: PluginInstallationTarget;
  handler: string;
  /** The delivery id the handler receives: `whk-<webhook>:<sender's id>`, or `whk-<webhook>/<ProPR id>` without one. */
  deliveryId: string;
  input: Omit<PluginWebhookInput, 'attempt' | 'deliveryId'>;
}
/** `gone`: the installation that accepted the request was uninstalled, reinstalled or disabled since; nothing was recorded. */
export type PluginWebhookAcceptance = { accepted: true; recordId: number } | { accepted: false; reason: 'duplicate' | 'busy' | 'gone' };

/** The outcome of an attempt whose handler ran, until it is recorded. */
interface Outcome { attempt: number; status: 'succeeded' | 'failed' | 'retrying'; update: Partial<PluginDeliveryRow>; finishedAt: number; nextAttemptAt: number | null }
interface Held {
  job: PluginWebhookJob; recordId: number; attempt: number; timer?: NodeJS.Timeout;
  /** The attempt number being marked `running`: set before the write, so a mark that committed but reported failure is recognized. */
  marking?: number;
  outcome?: Outcome;
  /** Consecutive failed database writes. */
  failures: number;
}

const LOST = 'Not delivered: ProPR stopped before the delivery finished, and webhook requests are not kept';
const UNFINISHED = ['pending', 'running', 'retrying'] as const;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_OWNER_TTL_MS = 120_000;
const DEFAULT_PERSIST_RETRY_MS = [1_000, 5_000, 30_000, 60_000] as const;
const WITHHELD_LOG = 'Message not kept: webhook handler output may contain the request';

/**
 * What a webhook attempt keeps of the handler's diagnostics: its log lines'
 * levels and times, and a fixed error. Never a message, field or error text
 * the handler wrote, which may repeat any part of the request (the
 * credential redaction does not recognize arbitrary request content).
 */
export function webhookDiagnostics(run: Pick<PluginHandlerRun, 'outcome' | 'timedOut' | 'logs'>): { error: string | null; logs: PluginLogLine[] } {
  const error = run.outcome === 'succeeded' ? null : run.timedOut ? 'The webhook handler timed out' : 'The webhook handler failed (its error is not kept: it may contain the request)';
  return { error, logs: run.logs.map(line => ({ level: line.level, message: WITHHELD_LOG, at: line.at })) };
}

export class PluginWebhookRunner {
  private readonly held = new Map<number, Held>();
  private readonly running = new Set<Promise<void>>();
  /** Deliveries whose next attempt starts at once (not a retry delay). */
  private readonly due = new Set<number>();
  private readonly now: () => number;
  private readonly delays: readonly number[];
  /** Records reserved (`reserve`) and not yet started, released or answered. */
  private readonly reserved = new Set<number>();
  /** Capacity slots claimed by `reserve` calls still awaiting their record: counted with `held` and `reserved`, so concurrent requests cannot exceed `maxPending`. */
  private claiming = 0;
  /** Reserved records being given back (`release`), with the timer of the next try after a failed delete. */
  private readonly releasing = new Map<number, NodeJS.Timeout | undefined>();
  private closed = false;
  /** This runner's name in `plugin_deliveries.webhook_owner` and `plugin_webhook_runners`. */
  readonly owner: string;
  private registered?: Promise<void>;
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly options: PluginWebhookRunnerOptions) {
    this.now = options.now ?? Date.now;
    this.delays = options.retryDelaysMs ?? PLUGIN_DELIVERY_RETRY_DELAYS_MS;
    this.owner = options.owner ?? `webhooks-${process.pid}-${randomUUID()}`;
  }

  /** Deliveries held right now (waiting, running or retrying). */
  get pending(): number { return this.held.size; }

  /** Record this runner's heartbeat; the first call also starts renewing it. Before any record names this runner as its owner. */
  private register(): Promise<void> {
    this.registered ??= this.beat().then(() => {
      if (this.closed) return;
      this.heartbeat = setInterval(() => {
        void this.beat().then(() => this.recoverStopped()).catch((error: unknown) => {
          logger.warn({ owner: this.owner, error: error instanceof Error ? error.message : String(error) }, '[plugins] Webhook runner heartbeat failed');
        });
      }, this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
      this.heartbeat.unref?.();
    }, (error: unknown) => { this.registered = undefined; throw error; });
    return this.registered;
  }

  private async beat(): Promise<void> {
    if (this.closed) return;
    await this.options.database('plugin_webhook_runners').insert({ owner: this.owner, heartbeat_at: this.now() }).onConflict('owner').merge(['heartbeat_at']);
  }

  /**
   * Mark failed the unfinished webhook deliveries whose owner has stopped
   * (its heartbeat lapsed, or the record has no owner): their requests were
   * never stored. One statement, so a live owner's renewed heartbeat and its
   * deliveries are read together; this runner's own are never touched.
   */
  private async recoverStopped(): Promise<number> {
    const { database } = this.options;
    const cutoff = this.now() - (this.options.ownerTtlMs ?? DEFAULT_OWNER_TTL_MS);
    const failed = await database('plugin_deliveries').where({ kind: 'webhook' }).whereIn('status', UNFINISHED)
      .where(q => {
        void q.whereNull('webhook_owner').orWhere(owner => {
          void owner.whereNot('webhook_owner', this.owner)
            .whereNotIn('webhook_owner', database('plugin_webhook_runners').where('heartbeat_at', '>=', cutoff).select('owner'));
        });
      })
      .update({ status: 'failed', next_attempt_at: null, finished_at: this.now(), error: LOST });
    await database('plugin_webhook_runners').where('heartbeat_at', '<', cutoff).whereNot('owner', this.owner).delete();
    return failed + await this.recoverOrphaned();
  }

  /**
   * Mark failed this runner's unfinished deliveries it no longer holds or has
   * reserved: their request is gone (a write lost track of them). Skipped
   * while a reservation is being written, whose record may not be known yet.
   */
  private async recoverOrphaned(): Promise<number> {
    const { database } = this.options;
    const own = (await database('plugin_deliveries').where({ kind: 'webhook', webhook_owner: this.owner }).whereIn('status', UNFINISHED).pluck('id') as unknown[]).map(Number);
    if (this.claiming) return 0;
    const orphans = own.filter(id => !this.held.has(id) && !this.reserved.has(id));
    if (!orphans.length) return 0;
    return database('plugin_deliveries').whereIn('id', orphans).where({ webhook_owner: this.owner }).whereIn('status', UNFINISHED)
      .update({ status: 'failed', next_attempt_at: null, finished_at: this.now(), error: LOST });
  }

  /**
   * Start this runner's heartbeat and mark failed the webhook deliveries left
   * unfinished by runners that have stopped. Deliveries of runners still alive
   * (in other API processes) are left alone. Repeated with every heartbeat.
   */
  async recover(): Promise<number> {
    await this.register();
    return this.recoverStopped();
  }

  /**
   * Record the delivery, owned by this runner, without running it yet: the
   * delivery id is taken, so a replay is refused while the receiver decides.
   * Then `start`, `answered` or `release` it. Refused as `duplicate` when the
   * installation already recorded this delivery id and the delivery is under
   * way or succeeded (a replay). A failed delivery's record is replaced: its
   * request was not kept, so the sender's redelivery is the only way to
   * deliver it. Refused as `busy` when
   * too many deliveries are held, and as `gone` when the target installation
   * is no longer installed (as the same installation) and enabled.
   *
   * The capacity slot is claimed before the first await and handed to
   * `reserved` (or given back) when the record is written or refused, so
   * concurrent requests are admitted against one count. The installation is
   * checked in the transaction that writes the record: an uninstall either
   * commits first (nothing is recorded) or after (and deletes the record).
   */
  async reserve(job: Pick<PluginWebhookJob, 'target' | 'handler' | 'deliveryId'> & { webhook: string }): Promise<PluginWebhookAcceptance> {
    if (this.closed || this.held.size + this.reserved.size + this.claiming >= (this.options.maxPending ?? PLUGIN_WEBHOOK_LIMITS.pending)) return { accepted: false, reason: 'busy' };
    this.claiming++;
    try {
      await this.register();
      if (this.closed) return { accepted: false, reason: 'busy' };
      const { target } = job;
      const recordId = await this.options.database.transaction(async trx => {
        const installed = await trx('plugin_installations').where({ plugin_id: target.pluginId }).first('enabled', 'installed_at') as Pick<PluginInstallationRow, 'enabled' | 'installed_at'> | undefined;
        if (!installed || !installed.enabled || Number(installed.installed_at) !== target.record.installedAt) return 'gone' as const;
        // A failed delivery is final and its request is gone: the sender's redelivery replaces its record (a new id, so a runner still holding the old one writes nothing to it).
        await trx('plugin_deliveries').where({ plugin_id: target.pluginId, delivery_id: job.deliveryId, kind: 'webhook', status: 'failed' }).delete();
        const now = this.now();
        const inserted = await trx('plugin_deliveries').insert({
          plugin_id: target.pluginId, delivery_id: job.deliveryId, kind: 'webhook', repository: '', event_seq: 0,
          event_type: `webhook.${job.webhook}`, handler: job.handler, status: 'pending', attempt: 0, next_attempt_at: now, created_at: now, logs: '[]',
          webhook_owner: this.owner,
        }).onConflict(['plugin_id', 'delivery_id']).ignore().returning('id') as Array<{ id: number } | number>;
        const first = inserted[0];
        if (first === undefined) return 'duplicate' as const;
        return typeof first === 'number' ? first : Number(first.id);
      });
      if (typeof recordId !== 'number') return { accepted: false, reason: recordId };
      // Synchronously with giving the claimed slot back (finally): the slot passes to the record.
      this.reserved.add(recordId);
      return { accepted: true, recordId };
    } finally {
      this.claiming--;
    }
  }

  /**
   * Give a reserved delivery id back (the request was refused before
   * delivery): the sender may send it again. The reservation is kept until
   * the record is deleted; a failed delete is retried in the background
   * (until this runner stops, when its records are failed by recovery).
   */
  async release(recordId: number): Promise<void> {
    if (!this.reserved.has(recordId) || this.releasing.has(recordId)) return;
    this.releasing.set(recordId, undefined);
    await this.giveBack(recordId, 0);
  }

  private async giveBack(recordId: number, failures: number): Promise<void> {
    this.releasing.set(recordId, undefined);
    try {
      await this.options.database('plugin_deliveries').where({ id: recordId, status: 'pending', webhook_owner: this.owner }).delete();
      this.releasing.delete(recordId);
      this.reserved.delete(recordId);
    } catch (error) {
      logger.warn({ recordId, error: error instanceof Error ? error.message : String(error) }, '[plugins] Webhook reservation failed to release; retrying');
      if (this.closed) { this.releasing.delete(recordId); return; }
      const timer = setTimeout(() => { void this.giveBack(recordId, failures + 1); }, this.persistDelay(failures));
      timer.unref?.();
      this.releasing.set(recordId, timer);
    }
  }

  /**
   * A reserved delivery answered at once by the webhook's respond function:
   * final, and its delivery id stays taken. When the write fails it throws
   * and the reservation is kept, for the caller to `release`.
   */
  async answered(recordId: number, respond: string): Promise<void> {
    if (!this.reserved.has(recordId) || this.releasing.has(recordId)) return;
    const now = this.now();
    await this.options.database('plugin_deliveries').where({ id: recordId, status: 'pending', webhook_owner: this.owner })
      .update({ status: 'succeeded', handler: respond, next_attempt_at: null, started_at: now, finished_at: now, duration_ms: 0 });
    this.reserved.delete(recordId);
  }

  /** Run a reserved delivery soon. False when this runner has stopped since: the record is marked failed. */
  async start(recordId: number, job: PluginWebhookJob): Promise<boolean> {
    if (!this.reserved.delete(recordId)) return false;
    if (this.closed) {
      await this.options.database('plugin_deliveries').where({ id: recordId, status: 'pending', webhook_owner: this.owner })
        .update({ status: 'failed', next_attempt_at: null, finished_at: this.now(), error: LOST });
      return false;
    }
    this.held.set(recordId, { job, recordId, attempt: 0, failures: 0 });
    this.schedule(recordId, 0);
    return true;
  }

  /** `reserve` then `start`: record the delivery and run it soon. */
  async accept(job: PluginWebhookJob): Promise<PluginWebhookAcceptance> {
    const reserved = await this.reserve({ ...job, webhook: job.input.webhook });
    if (!reserved.accepted) return reserved;
    return await this.start(reserved.recordId, job) ? reserved : { accepted: false, reason: 'busy' };
  }

  /** Wait until no attempt, write or release is under way or due: every held delivery is final or waits for a retry (tests). */
  async idle(): Promise<void> {
    while (this.running.size || this.due.size || this.releasing.size) {
      if (this.running.size) await Promise.all([...this.running]);
      else await new Promise(resolve => setImmediate(resolve));
    }
  }

  /** Stop: no further attempt starts; attempts under way finish; deliveries still waiting are marked failed. */
  async stop(): Promise<void> {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const held of this.held.values()) clearTimeout(held.timer);
    for (const timer of this.releasing.values()) clearTimeout(timer);
    this.releasing.clear();
    this.due.clear();
    await this.idle();
    const ids = [...this.held.keys()];
    this.held.clear();
    if (ids.length) await this.options.database('plugin_deliveries').whereIn('id', ids).whereIn('status', UNFINISHED)
      .update({ status: 'failed', next_attempt_at: null, finished_at: this.now(), error: LOST }).catch(() => undefined);
    // Wait for a heartbeat under way, then withdraw it: another process may fail what is left at once.
    await this.registered?.catch(() => undefined);
    await this.options.database('plugin_webhook_runners').where({ owner: this.owner }).delete().catch(() => undefined);
  }

  private persistDelay(failures: number): number {
    const delays = this.options.persistRetryMs ?? DEFAULT_PERSIST_RETRY_MS;
    return delays.length ? delays[Math.min(failures, delays.length - 1)] : 0;
  }

  /**
   * Run the delivery's next step after `delayMs`. A database write that fails
   * keeps the delivery held and tries again on `persistRetryMs`: before its
   * handler ran, the attempt starts over; after, only its outcome is written.
   */
  private schedule(recordId: number, delayMs: number, writeRetry = false): void {
    const held = this.held.get(recordId);
    if (!held || this.closed) return;
    // A write being retried counts as under way, like an attempt due at once.
    if (delayMs <= 0 || writeRetry) this.due.add(recordId);
    held.timer = setTimeout(() => {
      this.due.delete(recordId);
      const attempt = this.attempt(held).then(() => { held.failures = 0; }, (error: unknown) => {
        logger.warn({ pluginId: held.job.target.pluginId, deliveryId: held.job.deliveryId, error: error instanceof Error ? error.message : String(error) }, '[plugins] Webhook delivery attempt failed to record; retrying');
        this.schedule(recordId, this.persistDelay(held.failures++), true);
      }).finally(() => { this.running.delete(attempt); });
      this.running.add(attempt);
    }, delayMs);
    held.timer.unref?.();
  }

  /** The installation as it is now, if it may still receive this delivery: installed as the same installation and enabled. */
  private async current(held: Held): Promise<PluginInstallationTarget | null> {
    const { target } = held.job;
    const row = await this.options.database('plugin_installations').where({ plugin_id: target.pluginId }).first() as PluginInstallationRow | undefined;
    if (!row || !row.enabled || Number(row.installed_at) !== target.record.installedAt) return null;
    return { ...target, record: installationRecord(row) };
  }

  private async finish(held: Held, update: Partial<PluginDeliveryRow>): Promise<void> {
    await this.options.database('plugin_deliveries').where({ id: held.recordId }).update(update);
  }

  private async attempt(held: Held): Promise<void> {
    if (this.closed) return;
    if (held.outcome) return this.record(held, held.outcome);
    const { database } = this.options;
    const target = await this.current(held);
    const previous = await database('plugin_deliveries').where({ id: held.recordId }).first('status', 'attempt') as Pick<PluginDeliveryRow, 'status' | 'attempt'> | undefined;
    const attempt = held.attempt + 1;
    // This attempt's mark committed although its write reported failure: the handler has not run yet.
    const marked = previous?.status === 'running' && held.marking === attempt && Number(previous.attempt) === attempt;
    // Uninstalled (the record is gone) or finished by someone else (enabled again marks unfinished deliveries failed).
    if (!previous || (!marked && previous.status !== 'pending' && previous.status !== 'retrying')) { this.held.delete(held.recordId); return; }
    if (!target) {
      await this.finish(held, { status: 'failed', next_attempt_at: null, finished_at: this.now(), error: 'Not delivered: the plugin was disabled' });
      this.held.delete(held.recordId);
      return;
    }
    if (!marked) {
      held.marking = attempt;
      const updated = await database('plugin_deliveries').where({ id: held.recordId, status: previous.status })
        .update({ status: 'running', attempt, started_at: this.now(), finished_at: null });
      if (updated !== 1) { this.held.delete(held.recordId); return; }
    }
    held.marking = undefined;
    held.attempt = attempt;
    let run: PluginHandlerRun;
    try {
      run = await (this.options.run ?? runPluginHandler)(target, held.job.handler, { ...held.job.input, kind: 'webhook', deliveryId: held.job.deliveryId, attempt }, { ...this.options, database });
    } catch (error) {
      run = { outcome: 'failed', timedOut: false, durationMs: 0, error: error instanceof Error ? error.message : 'The handler failed', logs: [] };
    }
    const now = this.now();
    const status = run.outcome === 'succeeded' ? 'succeeded' : attempt > this.delays.length ? 'failed' : 'retrying';
    const nextAttemptAt = status === 'retrying' ? now + this.delays[attempt - 1] : null;
    // Only while the record is still this attempt's: a restart (enabled again) or an uninstall since then wins.
    const diagnostics = webhookDiagnostics(run);
    // Kept until written: a failed write is retried without running the handler again.
    held.outcome = {
      attempt, status, finishedAt: now, nextAttemptAt,
      update: { status, finished_at: now, duration_ms: run.durationMs, timed_out: run.timedOut, error: diagnostics.error, logs: storedLogs(diagnostics.logs), next_attempt_at: nextAttemptAt },
    };
    await this.record(held, held.outcome);
  }

  /** Write an attempt's outcome, then retry later or let the delivery go. */
  private async record(held: Held, outcome: Outcome): Promise<void> {
    const { database } = this.options;
    let recorded = await database('plugin_deliveries').where({ id: held.recordId, status: 'running', attempt: outcome.attempt }).update(outcome.update) === 1;
    if (!recorded && held.failures > 0) {
      // A previous write may have committed although it reported failure.
      const row = await database('plugin_deliveries').where({ id: held.recordId }).first('status', 'attempt', 'finished_at') as Pick<PluginDeliveryRow, 'status' | 'attempt' | 'finished_at'> | undefined;
      recorded = row?.status === outcome.status && Number(row.attempt) === outcome.attempt && Number(row.finished_at) === outcome.finishedAt;
    }
    held.outcome = undefined;
    if (!recorded || outcome.status !== 'retrying') { this.held.delete(held.recordId); return; }
    this.schedule(held.recordId, outcome.nextAttemptAt! - this.now());
  }
}
