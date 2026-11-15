import type { Knex } from 'knex';
import { PLUGIN_DELIVERY_RETRY_DELAYS_MS, PLUGIN_WEBHOOK_LIMITS, type PluginHandlerRun, type PluginWebhookInput } from '@propr/shared';
import logger from '../utils/logger.js';
import { runPluginHandler, type RunPluginHandlerOptions } from './pluginHandlerRunner.js';
import { installationRecord, type PluginInstallationRow } from './pluginState.js';
import { clipError, storedLogs, type PluginDeliveryRow } from './pluginDeliveries.js';
import type { PluginInstallationTarget } from './pluginContext.js';

/**
 * Runs verified inbound webhook requests through their handlers, as
 * deliveries of kind `webhook` recorded in the plugin's Activity like event
 * deliveries, with the same retry schedule (1 min, 5 min, 30 min, 2 h, then
 * failed).
 *
 * The request (body and headers) is held in this process's memory only, never
 * written anywhere: the delivery record carries the webhook and handler
 * names, the delivery id, status, timing and the handler's redacted error and
 * log lines. A delivery still waiting when the process stops cannot be
 * resumed by another one and is marked failed.
 */
export interface PluginWebhookRunnerOptions extends Omit<RunPluginHandlerOptions, 'database'> {
  database: Knex;
  retryDelaysMs?: readonly number[];
  /** Deliveries held in memory at once; further requests are refused (503) until some finish. */
  maxPending?: number;
  run?: typeof runPluginHandler;
}

export interface PluginWebhookJob {
  target: PluginInstallationTarget;
  handler: string;
  /** The delivery id the handler receives: `whk-<webhook>-<sender's id or a ProPR id>`. */
  deliveryId: string;
  input: Omit<PluginWebhookInput, 'attempt' | 'deliveryId'>;
}
export type PluginWebhookAcceptance = { accepted: true; recordId: number } | { accepted: false; reason: 'duplicate' | 'busy' };

interface Held { job: PluginWebhookJob; recordId: number; attempt: number; timer?: NodeJS.Timeout }

const LOST = 'Not delivered: ProPR stopped before the delivery finished, and webhook requests are not kept';
const UNFINISHED = ['pending', 'running', 'retrying'] as const;

export class PluginWebhookRunner {
  private readonly held = new Map<number, Held>();
  private readonly running = new Set<Promise<void>>();
  /** Deliveries whose next attempt starts at once (not a retry delay). */
  private readonly due = new Set<number>();
  private readonly now: () => number;
  private readonly delays: readonly number[];
  private closed = false;

  constructor(private readonly options: PluginWebhookRunnerOptions) {
    this.now = options.now ?? Date.now;
    this.delays = options.retryDelaysMs ?? PLUGIN_DELIVERY_RETRY_DELAYS_MS;
  }

  /** Deliveries held right now (waiting, running or retrying). */
  get pending(): number { return this.held.size; }

  /** Mark webhook deliveries an earlier process left unfinished as failed: their requests were never stored. */
  async recover(): Promise<number> {
    return this.options.database('plugin_deliveries').where({ kind: 'webhook' }).whereIn('status', UNFINISHED)
      .modify(q => { if (this.held.size) void q.whereNotIn('id', [...this.held.keys()]); })
      .update({ status: 'failed', next_attempt_at: null, finished_at: this.now(), error: LOST });
  }

  /**
   * Record the delivery and run it soon. Refused as `duplicate` when the
   * installation already recorded this delivery id (a replay), and as `busy`
   * when too many deliveries are held.
   */
  async accept(job: PluginWebhookJob): Promise<PluginWebhookAcceptance> {
    if (this.closed || this.held.size >= (this.options.maxPending ?? PLUGIN_WEBHOOK_LIMITS.pending)) return { accepted: false, reason: 'busy' };
    const now = this.now();
    const inserted = await this.options.database('plugin_deliveries').insert({
      plugin_id: job.target.pluginId, delivery_id: job.deliveryId, kind: 'webhook', repository: '', event_seq: 0,
      event_type: `webhook.${job.input.webhook}`, handler: job.handler, status: 'pending', attempt: 0, next_attempt_at: now, created_at: now, logs: '[]',
    }).onConflict(['plugin_id', 'delivery_id']).ignore().returning('id') as Array<{ id: number } | number>;
    const first = inserted[0];
    if (first === undefined) return { accepted: false, reason: 'duplicate' };
    const recordId = typeof first === 'number' ? first : Number(first.id);
    this.held.set(recordId, { job, recordId, attempt: 0 });
    this.schedule(recordId, 0);
    return { accepted: true, recordId };
  }

  /** Wait until no attempt is under way or due at once: every held delivery is final or waits for a retry (tests). */
  async idle(): Promise<void> {
    while (this.running.size || this.due.size) {
      if (this.running.size) await Promise.all([...this.running]);
      else await new Promise(resolve => setImmediate(resolve));
    }
  }

  /** Stop: no further attempt starts; attempts under way finish; deliveries still waiting are marked failed. */
  async stop(): Promise<void> {
    this.closed = true;
    for (const held of this.held.values()) clearTimeout(held.timer);
    this.due.clear();
    await this.idle();
    const ids = [...this.held.keys()];
    this.held.clear();
    if (ids.length) await this.options.database('plugin_deliveries').whereIn('id', ids).whereIn('status', UNFINISHED)
      .update({ status: 'failed', next_attempt_at: null, finished_at: this.now(), error: LOST }).catch(() => undefined);
  }

  private schedule(recordId: number, delayMs: number): void {
    const held = this.held.get(recordId);
    if (!held || this.closed) return;
    if (delayMs <= 0) this.due.add(recordId);
    held.timer = setTimeout(() => {
      this.due.delete(recordId);
      const attempt = this.attempt(held).catch((error: unknown) => {
        logger.warn({ pluginId: held.job.target.pluginId, deliveryId: held.job.deliveryId, error: error instanceof Error ? error.message : String(error) }, '[plugins] Webhook delivery attempt failed to record');
        this.held.delete(recordId);
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
    const { database } = this.options;
    const target = await this.current(held);
    const previous = await database('plugin_deliveries').where({ id: held.recordId }).first('status') as Pick<PluginDeliveryRow, 'status'> | undefined;
    // Uninstalled (the record is gone) or finished by someone else (enabled again marks unfinished deliveries failed).
    if (!previous || (previous.status !== 'pending' && previous.status !== 'retrying')) { this.held.delete(held.recordId); return; }
    if (!target) {
      await this.finish(held, { status: 'failed', next_attempt_at: null, finished_at: this.now(), error: 'Not delivered: the plugin was disabled' });
      this.held.delete(held.recordId);
      return;
    }
    const attempt = held.attempt + 1;
    const marked = await database('plugin_deliveries').where({ id: held.recordId, status: previous.status })
      .update({ status: 'running', attempt, started_at: this.now(), finished_at: null });
    if (marked !== 1) { this.held.delete(held.recordId); return; }
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
    const recorded = await database('plugin_deliveries').where({ id: held.recordId, status: 'running', attempt }).update({
      status, finished_at: now, duration_ms: run.durationMs, timed_out: run.timedOut, error: clipError(run.error), logs: storedLogs(run.logs), next_attempt_at: nextAttemptAt,
    });
    if (recorded !== 1 || status !== 'retrying') { this.held.delete(held.recordId); return; }
    this.schedule(held.recordId, nextAttemptAt! - now);
  }
}
