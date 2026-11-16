import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { PLUGIN_DELIVERY_RETRY_DELAYS_MS, PLUGIN_HANDLER_TIMEOUT_MS, type CommandTarget, type PluginCommandInput, type PluginHandlerRun } from '@propr/shared';
import logger from '../utils/logger.js';
import { officialPluginCatalog } from './pluginCatalog.js';
import { runPluginHandler, type RunPluginHandlerOptions } from './pluginHandlerRunner.js';
import { installationRecord, type PluginInstallationRow } from './pluginState.js';
import { clipError, storedLogs, type PluginDeliveryRow } from './pluginDeliveries.js';
import type { PluginCommandDelivery } from './pluginCommands.js';

/**
 * `handler` slash commands, delivered to their plugin's handler as deliveries
 * of kind `command`, recorded in the plugin's Activity like event deliveries.
 *
 * The comment intake records the delivery (`enqueuePluginCommandDelivery`)
 * with its comment context; a runner in the daemon (`PluginCommandRunner`)
 * attempts it with the same retry schedule as events (1 min, 5 min, 30 min,
 * 2 h, then failed). Delivery is at least once: the delivery id
 * (`cmd-<target>-<comment id>`) is the same on every attempt and for every
 * redelivery of the comment, so the comment is recorded once.
 */

/** The comment context of one command delivery, stored with it. */
export interface PluginCommandContext { repository: string; number: number; target: CommandTarget; actor: string; commentId: number }
interface StoredCommandInput extends PluginCommandContext { command: string; args: string }

export const pluginCommandDeliveryId = (target: CommandTarget, commentId: number) => `cmd-${target}-${commentId}`;

/**
 * Record a command delivery, pending. False when the plugin is no longer
 * enabled, or this comment's delivery was already recorded (a redelivery).
 */
export async function enqueuePluginCommandDelivery(database: Knex, delivery: PluginCommandDelivery, context: PluginCommandContext, now: number = Date.now()): Promise<boolean> {
  const input: StoredCommandInput = { ...context, command: delivery.command, args: delivery.argument };
  return database.transaction(async trx => {
    const installed = await trx('plugin_installations').where({ plugin_id: delivery.pluginId, enabled: true }).first('plugin_id');
    if (!installed) return false;
    const inserted = await trx('plugin_deliveries').insert({
      plugin_id: delivery.pluginId, delivery_id: pluginCommandDeliveryId(context.target, context.commentId), kind: 'command',
      repository: context.repository, event_seq: context.number, event_type: `command.${delivery.command}`, handler: delivery.handler,
      status: 'pending', attempt: 0, next_attempt_at: now, created_at: now, logs: '[]', command_input: JSON.stringify(input),
    }).onConflict(['plugin_id', 'delivery_id']).ignore().returning('id') as unknown[];
    return inserted.length > 0;
  });
}

export type PluginCommandEnqueuer = (delivery: PluginCommandDelivery, context: PluginCommandContext) => Promise<boolean>;
let enqueuer: PluginCommandEnqueuer | null = null;
/** Replace how comment intake records a command delivery (tests), or restore the default with null. */
export function setPluginCommandEnqueuer(next: PluginCommandEnqueuer | null): void { enqueuer = next; }
/** Record a command delivery as comment intake does: in the instance database. */
export async function enqueueCommentPluginCommand(delivery: PluginCommandDelivery, context: PluginCommandContext): Promise<boolean> {
  if (enqueuer) return enqueuer(delivery, context);
  const { db } = await import('../db/connection.js');
  return enqueuePluginCommandDelivery(db, delivery, context);
}

function parseInput(text: string | null | undefined): StoredCommandInput | null {
  try {
    const value = JSON.parse(text ?? '') as Partial<StoredCommandInput>;
    if (typeof value.repository !== 'string' || typeof value.number !== 'number' || (value.target !== 'issue' && value.target !== 'pull_request')
      || typeof value.actor !== 'string' || typeof value.commentId !== 'number' || typeof value.command !== 'string' || typeof value.args !== 'string') return null;
    return value as StoredCommandInput;
  } catch { return null; }
}

export interface PluginCommandRunnerOptions extends Omit<RunPluginHandlerOptions, 'database'> {
  database: Knex;
  retryDelaysMs?: readonly number[];
  /** Interval between passes. */
  pollMs?: number;
  /** A `running` attempt older than this was left by a stopped process and is attempted again. */
  staleMs?: number;
  /** Deliveries attempted per pass. */
  batchSize?: number;
  run?: typeof runPluginHandler;
}

const DEFAULT_POLL_MS = 3_000;
const DEFAULT_BATCH = 20;
const lower = (value: string) => value.toLowerCase();
type Row = PluginDeliveryRow & { command_input?: string | null };

/** Attempts the due command deliveries of every installation. Several runners may run: each attempt is claimed by one write. */
export class PluginCommandRunner {
  readonly owner = `commands-${process.pid}-${randomUUID()}`;
  private readonly now: () => number;
  private readonly delays: readonly number[];
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;
  private closed = false;

  constructor(private readonly options: PluginCommandRunnerOptions) {
    this.now = options.now ?? Date.now;
    this.delays = options.retryDelaysMs ?? PLUGIN_DELIVERY_RETRY_DELAYS_MS;
  }

  start(): void {
    if (this.closed || this.timer) return;
    const loop = () => {
      this.timer = setTimeout(() => { void this.pass().catch(() => 0).finally(() => { if (!this.closed) loop(); }); }, this.options.pollMs ?? DEFAULT_POLL_MS);
      this.timer.unref?.();
    };
    loop();
  }

  async stop(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer); this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  /** One pass over the due command deliveries; passes never overlap. Returns the attempts made. */
  pass(): Promise<number> {
    if (this.running) return this.running.then(() => this.pass());
    const run = this.passOnce().finally(() => { this.running = undefined; });
    this.running = run;
    return run;
  }

  private async passOnce(): Promise<number> {
    const now = this.now();
    const stale = now - (this.options.staleMs ?? 2 * (this.options.timeoutMs ?? PLUGIN_HANDLER_TIMEOUT_MS));
    const rows = await this.options.database('plugin_deliveries').where({ kind: 'command' })
      .where(q => {
        void q.where(due => { void due.whereIn('status', ['pending', 'retrying']).where('next_attempt_at', '<=', now); })
          .orWhere(left => { void left.where('status', 'running').where('started_at', '<', stale); });
      })
      .orderBy('id').limit(this.options.batchSize ?? DEFAULT_BATCH).select() as Row[];
    let attempts = 0;
    for (const row of rows) {
      if (this.closed) break;
      try { if (await this.attempt(row)) attempts++; } catch (error) {
        logger.warn({ pluginId: row.plugin_id, deliveryId: row.delivery_id, error: error instanceof Error ? error.message : String(error) }, '[plugins] Command delivery attempt failed to record');
      }
    }
    return attempts;
  }

  private async fail(row: Row, error: string): Promise<void> {
    await this.options.database('plugin_deliveries').where({ id: row.id, status: row.status, attempt: row.attempt })
      .update({ status: 'failed', next_attempt_at: null, finished_at: this.now(), error });
  }

  /** Whether the installation pauses its deliveries (after repeated failures): the command waits for a Resume. */
  private async paused(pluginId: string): Promise<boolean> {
    const row = await this.options.database('plugin_dispatch').where({ plugin_id: pluginId }).first('paused_at') as { paused_at: number | string | null } | undefined;
    return row?.paused_at !== null && row?.paused_at !== undefined;
  }

  // eslint-disable-next-line complexity -- the checks before one attempt stay in reading order
  private async attempt(row: Row): Promise<boolean> {
    const { database } = this.options;
    const input = parseInput(row.command_input);
    if (!input || !row.handler) { await this.fail(row, 'Not delivered: the command delivery record is incomplete'); return false; }
    const installed = await database('plugin_installations').where({ plugin_id: row.plugin_id }).first() as PluginInstallationRow | undefined;
    if (!installed || !installed.enabled) { await this.fail(row, 'Not delivered: the plugin was disabled'); return false; }
    const manifest = (await (this.options.catalog ?? officialPluginCatalog)()).find(m => m.id === row.plugin_id);
    const command = manifest?.contributes.commands.find(c => c.name === input.command);
    if (!manifest || command?.kind !== 'handler' || command.handler !== row.handler) { await this.fail(row, 'Not delivered: the plugin no longer has this command'); return false; }
    const record = installationRecord(installed);
    if (record.repositories?.length && !record.repositories.map(lower).includes(lower(input.repository))) {
      await this.fail(row, "Not delivered: the repository is outside the plugin's repository limit"); return false;
    }
    if (await this.paused(row.plugin_id)) return false;
    const attempt = Number(row.attempt) + 1;
    const claimed = await database('plugin_deliveries').where({ id: row.id, status: row.status, attempt: row.attempt })
      .update({ status: 'running', attempt, started_at: this.now(), finished_at: null });
    if (claimed !== 1) return false;
    const handlerInput: PluginCommandInput = { kind: 'command', ...input, deliveryId: row.delivery_id, attempt };
    let run: PluginHandlerRun;
    try {
      run = await (this.options.run ?? runPluginHandler)({ pluginId: row.plugin_id, manifest, record }, row.handler, handlerInput, { ...this.options, database });
    } catch (error) {
      run = { outcome: 'failed', timedOut: false, durationMs: 0, error: error instanceof Error ? error.message : 'The handler failed', logs: [] };
    }
    const now = this.now();
    const status = run.outcome === 'succeeded' ? 'succeeded' : attempt > this.delays.length ? 'failed' : 'retrying';
    // Only while the record is still this attempt's: a restart (enabled again) or an uninstall since then wins.
    await database('plugin_deliveries').where({ id: row.id, status: 'running', attempt }).update({
      status, finished_at: now, duration_ms: run.durationMs, timed_out: run.timedOut, error: clipError(run.error), logs: storedLogs(run.logs),
      next_attempt_at: status === 'retrying' ? now + this.delays[attempt - 1] : null,
    });
    return true;
  }
}

