import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
  PLUGIN_DEGRADED_AFTER_FAILURES, PLUGIN_DELIVERY_RETRY_DELAYS_MS,
  type PluginHandlerRun, type PluginManifest, type PluginSubscription, type RepositoryEvent,
} from '@propr/shared';
import logger from '../utils/logger.js';
import { listRepositoryEvents, subscribeRepositoryEventAppends } from '../services/repositoryEventJournal.js';
import { officialPluginCatalog } from './pluginCatalog.js';
import { effectivePluginPermissions, type PluginInstallationTarget } from './pluginContext.js';
import { runPluginHandler, type RunPluginHandlerOptions } from './pluginHandlerRunner.js';
import { installationRecord, type PluginInstallationRow } from './pluginState.js';
import {
  attemptOutcome, clipError, journalHead, notifyAdministratorsOfDegradedPlugin, owedNoticesWith, pluginDeliveryId, pluginPauseAfterFailures, restartPluginDispatch, sendPendingDegradedNotices, storedLogs,
  type PluginDegradedNotice, type PluginDegradedNotifier, type PluginDeliveryRow, type PluginDispatchRow,
} from './pluginDeliveries.js';

/**
 * Delivers repository journal events to the handlers plugins subscribe to.
 *
 * Each installation reads the journal from its own durable cursor, kept per
 * repository (case-insensitive: every spelling of a name is one stream, keyed
 * by its lower-case form): events of one repository reach one plugin in `seq` order, one
 * at a time, while another repository's events go on. Delivery is at least
 * once, with a stable delivery id. A failed attempt is retried after 1 min,
 * 5 min, 30 min and 2 h (or after the delay a handler's `PluginDeliveryError`
 * asks for); then the delivery is marked failed and the next event follows. A
 * permanent `PluginDeliveryError` marks it failed at once. Only the worker holding an installation's lease delivers to it.
 *
 * The dispatcher only reads the journal. Nothing that appends an event waits
 * for it, so a handler that fails, hangs or crashes never fails or delays the
 * task, review, merge or queue step that produced the event.
 */
export interface PluginDispatcherOptions extends Omit<RunPluginHandlerOptions, 'database'> {
  database: Knex;
  /** This dispatcher's lease owner name; unique per process by default. */
  owner?: string;
  /** How long a lease lasts without renewal; longer than a handler's time limit. */
  leaseMs?: number;
  /** Waits before each retry; the delivery fails after `retryDelaysMs.length + 1` attempts. */
  retryDelaysMs?: readonly number[];
  degradedAfterFailures?: number;
  /** Defaults to `PROPR_PLUGIN_PAUSE_AFTER_FAILURES` or `PLUGIN_PAUSE_AFTER_FAILURES`. */
  pauseAfterFailures?: number;
  /** Interval between journal reads when no in-process append wakes the dispatcher. */
  pollMs?: number;
  /** Events read per repository and pass. */
  batchSize?: number;
  /** Runs one handler attempt; defaults to `runPluginHandler`. */
  run?: typeof runPluginHandler;
  /** Told once when an installation becomes Degraded; defaults to an Inbox notification to administrators. */
  notify?: PluginDegradedNotifier;
}

export interface PluginDispatchPass {
  /** Attempts made in this pass. */
  attempts: number;
  /** Installations this dispatcher held the lease of. */
  leased: string[];
}

const DEFAULT_LEASE_MS = 2 * 60_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_BATCH = 50;
const WAKE_DELAY_MS = 200;
/** Wait before a pass tries again to send Degraded notifications that failed. */
const NOTICE_RETRY_MS = 60_000;

const lower = (value: string) => value.toLowerCase();
/** The event value a filter key names: an event field or `payload.<key>`; a missing value is null. */
function filterValue(event: RepositoryEvent, key: string): unknown {
  if (key.startsWith('payload.')) {
    const name = key.slice('payload.'.length);
    return Object.hasOwn(event.payload, name) ? event.payload[name] : null;
  }
  return (event as unknown as Record<string, unknown>)[key] ?? null;
}
/** Whether a subscription takes this event: its `<domain>.<type>`, and every filter key equal to one of its values. */
export function subscriptionMatches(subscription: PluginSubscription, event: RepositoryEvent): boolean {
  if (subscription.on !== `${event.domain}.${event.type}`) return false;
  return Object.entries(subscription.filter ?? {}).every(([key, expected]) => {
    const actual = filterValue(event, key);
    return (Array.isArray(expected) ? expected : [expected]).some(option => (key === 'repository' && typeof actual === 'string' && typeof option === 'string'
      ? lower(actual) === lower(option) : actual === option));
  });
}

/** One installation's delivery in a pass: the target is refreshed before each attempt; `attempts` counts the handlers started. */
interface Installation { target: PluginInstallationTarget; state: PluginDispatchRow; attempts: number }
class LeaseLost extends Error {}
/** The repository waits (for a retry); the installation's other repositories go on. */
class Blocked extends Error {}
/** The installation's pass ends: paused, disabled, out of grant, restarted or changed under it. The next pass starts from the current state. */
class Stopped extends Error {}

const UNFINISHED = ['pending', 'running', 'retrying'] as const;
const inScope = (repositories: readonly string[] | null | undefined, repository: string) => !repositories || repositories.map(lower).includes(lower(repository));
const deliversEvents = (target: PluginInstallationTarget) => target.record.enabled && effectivePluginPermissions(target.manifest, target.record).includes('events.read');

export class PluginDispatcher {
  readonly owner: string;
  private readonly database: Knex;
  private readonly now: () => number;
  private readonly delays: readonly number[];
  private readonly pauseAfter: number;
  private readonly degradedAfter: number;
  private timer: NodeJS.Timeout | undefined;
  /** When the scheduled pass is due (wall clock). */
  private timerDue = 0;
  private unsubscribe: (() => void) | undefined;
  private running: Promise<PluginDispatchPass> | undefined;
  private again = false;
  /** Polling is on (between `start` and `stop`). */
  private polling = false;
  /** `stop` was called: no further attempt starts. */
  private closed = false;
  /** When a pass next sends owed Degraded notifications (after one failed). */
  private noticesDue = 0;

  constructor(private readonly options: PluginDispatcherOptions) {
    this.database = options.database;
    this.owner = options.owner ?? `dispatcher-${process.pid}-${randomUUID()}`;
    this.now = options.now ?? Date.now;
    this.delays = options.retryDelaysMs ?? PLUGIN_DELIVERY_RETRY_DELAYS_MS;
    this.degradedAfter = Math.max(1, options.degradedAfterFailures ?? PLUGIN_DEGRADED_AFTER_FAILURES);
    this.pauseAfter = Math.max(this.degradedAfter, options.pauseAfterFailures ?? pluginPauseAfterFailures(options.environment));
  }

  /** Poll the journal and react at once to appends in this process. */
  start(): void {
    if (this.polling || this.closed) return;
    this.polling = true;
    this.unsubscribe = subscribeRepositoryEventAppends(() => this.wake(WAKE_DELAY_MS));
    this.wake(0);
  }

  /** Stop polling, wait for the pass under way and hand the leases back. */
  async stop(): Promise<void> {
    this.polling = false; this.closed = true;
    clearTimeout(this.timer); this.timer = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    await this.running?.catch(() => undefined);
    await this.database('plugin_dispatch').where({ lease_owner: this.owner }).update({ lease_owner: null, lease_expires_at: null }).catch(() => undefined);
  }

  /** Schedule a pass in `delayMs`, unless one is due sooner: appends arriving without pause never push a pass back. */
  private wake(delayMs: number): void {
    if (!this.polling) return;
    if (this.running) { this.again = true; return; }
    const due = Date.now() + delayMs;
    if (this.timer && this.timerDue <= due) return;
    clearTimeout(this.timer);
    this.timerDue = due;
    this.timer = setTimeout(() => { void this.loop(); }, delayMs);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    this.timer = undefined;
    await this.pass().catch(() => undefined);
    const again = this.again; this.again = false;
    this.wake(again ? 0 : this.options.pollMs ?? DEFAULT_POLL_MS);
  }

  /** One pass over every enabled installation with subscriptions; passes never overlap. Never throws. */
  pass(): Promise<PluginDispatchPass> {
    if (this.running) return this.running.then(() => this.pass());
    const run = this.passOnce().finally(() => { this.running = undefined; });
    this.running = run;
    return run;
  }

  private async passOnce(): Promise<PluginDispatchPass> {
    const result: PluginDispatchPass = { attempts: 0, leased: [] };
    // Notifications owed by any installation, paused ones included.
    if (this.now() >= this.noticesDue) await this.sendNotices();
    let installations: Installation[];
    try { installations = await this.installations(); } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, '[plugins] Could not read plugin installations for event delivery');
      return result;
    }
    // Installations deliver side by side; each one's own events stay in order.
    await Promise.all(installations.map(async installation => {
      const { pluginId } = installation.target;
      try {
        if (!await this.acquire(pluginId)) return;
        result.leased.push(pluginId);
        await this.deliver(installation);
      } catch (error) {
        if (!(error instanceof LeaseLost) && !(error instanceof Stopped)) logger.warn({ pluginId, error: error instanceof Error ? error.message : String(error) }, '[plugins] Event delivery pass failed');
      } finally {
        result.attempts += installation.attempts;
      }
    }));
    return result;
  }

  private async installations(): Promise<Installation[]> {
    const manifests = await (this.options.catalog ?? officialPluginCatalog)();
    const rows = await this.database('plugin_installations').where({ enabled: true }).select() as PluginInstallationRow[];
    const found: Installation[] = [];
    for (const row of rows) {
      const manifest: PluginManifest | undefined = manifests.find(m => m.id === row.plugin_id);
      if (!manifest?.contributes.subscriptions.length) continue;
      const target = { pluginId: row.plugin_id, manifest, record: installationRecord(row) };
      // Subscriptions need events.read, granted and still asked for.
      if (!deliversEvents(target)) continue;
      const state = await this.state(row.plugin_id, target.record.installedAt);
      // Uninstalled, reinstalled or disabled since the read: the next pass starts from the installation as it is then.
      if (!state || state.paused_at !== null) continue;
      found.push({ target, state, attempts: 0 });
    }
    return found;
  }

  /**
   * The dispatch state of the installation read as `installedAt`; an
   * installation without one (or with an earlier installation's) starts at the
   * journal's end. State is only created or replaced in one transaction with
   * the check that the installation is still that one, enabled, and that the
   * state it replaces is still not its own: an installation read before an
   * uninstall, reinstall or disable never writes over its replacement's state
   * (that would move the replacement's start past events it must receive).
   * Undefined when the installation changed since it was read.
   */
  private async state(pluginId: string, installedAt: number): Promise<PluginDispatchRow | undefined> {
    const read = (database: Knex) => database('plugin_dispatch').where({ plugin_id: pluginId }).first() as Promise<PluginDispatchRow | undefined>;
    const row = await read(this.database);
    if (row && Number(row.installed_at) === installedAt) return row;
    return this.database.transaction(async trx => {
      const current = await trx('plugin_installations').where({ plugin_id: pluginId }).first('installed_at', 'enabled') as Pick<PluginInstallationRow, 'installed_at' | 'enabled'> | undefined;
      if (!current || Number(current.installed_at) !== installedAt || !current.enabled) return undefined;
      const existing = await read(trx);
      if (!existing) {
        await trx('plugin_dispatch').insert({ plugin_id: pluginId, installed_at: installedAt, start_seq: await journalHead(trx), consecutive_failures: 0, updated_at: this.now() });
      } else if (Number(existing.installed_at) !== installedAt) {
        await restartPluginDispatch(trx, pluginId, installedAt, this.now());
      }
      return read(trx);
    });
  }

  /** Take or renew the installation's lease: free, expired or already ours. */
  private async acquire(pluginId: string): Promise<boolean> {
    const now = this.now();
    const updated = await this.database('plugin_dispatch').where({ plugin_id: pluginId })
      .where(q => { void q.whereNull('lease_owner').orWhere('lease_owner', this.owner).orWhereNull('lease_expires_at').orWhere('lease_expires_at', '<', now); })
      .update({ lease_owner: this.owner, lease_expires_at: now + (this.options.leaseMs ?? DEFAULT_LEASE_MS) });
    return updated === 1;
  }
  private async renew(pluginId: string): Promise<void> {
    if (this.closed || !await this.acquire(pluginId)) throw new LeaseLost();
  }

  /** Deliver what is due for one installation. Ends with `Stopped` once it may no longer deliver (paused, for one). */
  private async deliver(installation: Installation): Promise<void> {
    await this.manualRetries(installation);
    for (const repository of await this.repositories(installation)) { // canonical (lower-case) names
      if (!inScope(installation.target.record.repositories, repository)) continue;
      try { await this.deliverRepository(installation, repository); } catch (error) {
        if (!(error instanceof Blocked)) throw error;
      }
    }
  }

  /**
   * The repositories to visit: those with events after the installation's
   * start, with unfinished deliveries, and those whose journal floor moved
   * past the start and past what their cursor has recorded, so a repository
   * that retention emptied still has its gap recorded. Each is named once, in
   * lower case, whatever spellings its events use.
   */
  private async repositories(installation: Installation): Promise<string[]> {
    const { pluginId } = installation.target;
    const start = Number(installation.state.start_seq);
    type Floor = { repository: string; floor_seq: number | string };
    const [events, unfinished, floors, cursors] = await Promise.all([
      this.database('repository_events').where('seq', '>', start).distinct('repository'),
      this.database('plugin_deliveries').where({ plugin_id: pluginId, kind: 'event' }).whereIn('status', UNFINISHED).distinct('repository'),
      this.database('repository_event_floors').where('floor_seq', '>', start + 1).select('repository', 'floor_seq'),
      this.database('plugin_delivery_cursors').where({ plugin_id: pluginId }).select('repository', 'floor_seq'),
    ]) as [{ repository: string }[], { repository: string }[], Floor[], Floor[]];
    const recorded = new Map(cursors.map(c => [c.repository, Number(c.floor_seq)]));
    const moved = floors.filter(f => Number(f.floor_seq) > (recorded.get(lower(f.repository)) ?? 0));
    return [...new Set([...events, ...unfinished, ...moved].map(r => lower(r.repository)))].sort();
  }

  /** Administrator retries: one attempt each, out of the stream's order; one a crashed worker left `running` is attempted again. */
  private async manualRetries(installation: Installation): Promise<void> {
    const { pluginId } = installation.target;
    const rows = await this.database('plugin_deliveries').where({ plugin_id: pluginId, kind: 'event', manual: true })
      .where(q => { void q.where(p => { void p.where('status', 'pending').where('next_attempt_at', '<=', this.now()); }).orWhere('status', 'running'); })
      .orderBy('id').select() as PluginDeliveryRow[];
    for (const row of rows) {
      const [event] = await listRepositoryEvents(this.database, { repository: row.repository, afterSeq: Number(row.event_seq) - 1, limit: 1 });
      if (!event || event.seq !== Number(row.event_seq)) {
        await this.fenced(installation, trx => trx('plugin_deliveries').where({ id: row.id, status: row.status, attempt: row.attempt })
          .update({ status: 'failed', manual: false, next_attempt_at: null, error: 'The event is no longer in the journal' }));
        continue;
      }
      await this.attempt(installation, row, event);
    }
  }

  /** Deliver one repository's events (every spelling, `repository` is the lower-case name) in order, until one waits for a retry or the batch is done. */
  private async deliverRepository(installation: Installation, repository: string): Promise<void> {
    const { pluginId, manifest } = installation.target;
    const cursor = await this.cursor(installation, repository);
    const events = await listRepositoryEvents(this.database, { repository, anyCase: true, afterSeq: cursor.seq, limit: this.options.batchSize ?? DEFAULT_BATCH });
    for (const event of events) {
      const subscriptions = manifest.contributes.subscriptions.filter(s => subscriptionMatches(s, event));
      for (const subscription of subscriptions) {
        const row = await this.delivery(installation, event, subscription.handler);
        if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'skipped') continue;
        if (row.status !== 'running' && Number(row.next_attempt_at ?? 0) > this.now()) throw new Blocked();
        const status = await this.attempt(installation, row, event);
        if (status !== 'succeeded' && status !== 'failed') throw new Blocked();
      }
      await this.fenced(installation, trx => trx('plugin_delivery_cursors').where({ plugin_id: pluginId, repository }).where('cursor_seq', '<', event.seq).update({ cursor_seq: event.seq }));
    }
  }

  /**
   * Run a cursor or record write in one transaction with the check that this
   * dispatcher still holds the lease of the installation it read: the same
   * installation and journal start. A restart (enabled again) or a reinstall
   * since the read ends the pass instead of writing state of the earlier one.
   */
  private async fenced<T>(installation: Installation, write: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    const { state } = installation;
    return this.database.transaction(async trx => {
      const current = await trx('plugin_dispatch').where({ plugin_id: state.plugin_id, lease_owner: this.owner, installed_at: state.installed_at, start_seq: state.start_seq }).first();
      if (!current) throw new Stopped();
      return write(trx);
    });
  }

  /** The repository's cursor, created at the installation's start; records a gap once when retention removed events not yet delivered. */
  private async cursor(installation: Installation, repository: string): Promise<{ seq: number }> {
    const { pluginId } = installation.target;
    const where = { plugin_id: pluginId, repository };
    let row = await this.database('plugin_delivery_cursors').where(where).first() as { cursor_seq: number | string; floor_seq: number | string } | undefined;
    if (!row) {
      const start = Number(installation.state.start_seq);
      // Only while the start read is still the installation's: a restart since then (enabled again) deleted the cursors and moved the start.
      row = await this.fenced(installation, async trx => {
        await trx('plugin_delivery_cursors').insert({ ...where, cursor_seq: start, floor_seq: 1 }).onConflict(['plugin_id', 'repository']).ignore();
        return await trx('plugin_delivery_cursors').where(where).first() as { cursor_seq: number | string; floor_seq: number | string };
      });
    }
    const seq = Number(row.cursor_seq);
    // The highest floor of any spelling: completeness of the stream ends there.
    const floors = await this.database('repository_event_floors').whereRaw('repository = ? COLLATE NOCASE', [repository]).max({ floor: 'floor_seq' }).first() as { floor: number | string | null } | undefined;
    const floor = Number(floors?.floor ?? 1);
    if (floor > Number(row.floor_seq)) await this.fenced(installation, async trx => {
      if (seq < floor - 1) {
        const now = this.now();
        await trx('plugin_deliveries').insert({
          plugin_id: pluginId, delivery_id: `gap-${seq + 1}-${floor - 1}-${repository}`.slice(0, 255), kind: 'gap', repository, event_seq: seq + 1,
          event_type: null, handler: null, status: 'skipped', attempt: 0, next_attempt_at: null, created_at: now, finished_at: now,
          error: `Events after ${seq} up to ${floor - 1} may have left the journal (retention) before they were delivered`, logs: '[]',
        }).onConflict(['plugin_id', 'delivery_id']).ignore();
      }
      // Unfinished deliveries of events retention removed are final now; retained events below the floor still go out.
      await trx('plugin_deliveries').where({ plugin_id: pluginId, kind: 'event' }).whereRaw('repository = ? COLLATE NOCASE', [repository])
        .whereIn('status', UNFINISHED).where('event_seq', '<', floor)
        .whereNotExists(q => { void q.select(1).from('repository_events').whereRaw('?? = ??', ['repository_events.seq', 'plugin_deliveries.event_seq']); })
        .update({ status: 'skipped', manual: false, next_attempt_at: null, finished_at: this.now(), error: 'The event left the journal (retention) before it was delivered' });
      await trx('plugin_delivery_cursors').where(where).update({ floor_seq: floor });
    });
    return { seq };
  }

  /** The delivery record of one event to one handler, created pending on first sight. */
  private async delivery(installation: Installation, event: RepositoryEvent, handler: string): Promise<PluginDeliveryRow> {
    const { pluginId } = installation.target;
    const deliveryId = pluginDeliveryId(event.seq, handler);
    await this.fenced(installation, trx => trx('plugin_deliveries').insert({
      plugin_id: pluginId, delivery_id: deliveryId, kind: 'event', repository: event.repository, event_seq: event.seq,
      event_type: `${event.domain}.${event.type}`, handler, status: 'pending', attempt: 0, next_attempt_at: this.now(), created_at: this.now(), logs: '[]',
    }).onConflict(['plugin_id', 'delivery_id']).ignore());
    return await this.database('plugin_deliveries').where({ plugin_id: pluginId, delivery_id: deliveryId }).first() as PluginDeliveryRow;
  }

  /**
   * Before each attempt: the lease is still ours and the installation, as it
   * is now, may receive this event. Paused, disabled, reinstalled, restarted
   * (enabled again) or without events.read ends the pass. A repository outside
   * the current limit ends an ordinary pass (the next one skips it) and fails
   * a manual retry. The target used for the attempt is the current one. An
   * administrator change landing between this check and the handler's start
   * is a race no check can close; the next attempt sees it.
   */
  private async admit(installation: Installation, row: PluginDeliveryRow, event: RepositoryEvent): Promise<boolean> {
    const { pluginId, manifest } = installation.target;
    await this.renew(pluginId);
    const [dispatch, current] = await Promise.all([
      this.database('plugin_dispatch').where({ plugin_id: pluginId }).first() as Promise<PluginDispatchRow | undefined>,
      this.database('plugin_installations').where({ plugin_id: pluginId }).first() as Promise<PluginInstallationRow | undefined>,
    ]);
    if (!dispatch || !current || dispatch.paused_at !== null || dispatch.lease_owner !== this.owner) throw new Stopped();
    const { state } = installation;
    if (Number(dispatch.installed_at) !== Number(state.installed_at) || Number(dispatch.start_seq) !== Number(state.start_seq)) throw new Stopped();
    const target = { pluginId, manifest, record: installationRecord(current) };
    if (target.record.installedAt !== installation.target.record.installedAt || !deliversEvents(target)) throw new Stopped();
    installation.target = target;
    const manual = Boolean(row.manual);
    if (!manual && event.seq <= Number(state.start_seq)) throw new Stopped();
    if (inScope(target.record.repositories, event.repository)) return true;
    if (!manual) throw new Stopped();
    await this.fenced(installation, trx => trx('plugin_deliveries').where({ id: row.id, status: row.status, attempt: row.attempt }).update({
      status: 'failed', manual: false, next_attempt_at: null, finished_at: this.now(), error: "Not delivered: the repository is outside the plugin's repository limit",
    }));
    return false;
  }

  /** One attempt: mark it running, run the handler, then record the outcome and the installation's health while still holding the lease. Ends the pass once it pauses the installation. */
  private async attempt(installation: Installation, row: PluginDeliveryRow, event: RepositoryEvent): Promise<PluginDeliveryRow['status'] | null> {
    if (!await this.admit(installation, row, event)) return null;
    const { pluginId } = installation.target;
    const manual = Boolean(row.manual);
    const attempt = Number(row.attempt) + 1;
    // The claim is fenced: only while this dispatcher still holds the lease of the installation and start it read,
    // the installation is still that one and enabled, and the record is unchanged. The lease is renewed in the same
    // write, so a worker suspended since `admit` (its lease taken over meanwhile) never starts the handler.
    const marked = await this.fenced(installation, async trx => {
      const enabled = await trx('plugin_installations').where({ plugin_id: pluginId, installed_at: installation.target.record.installedAt, enabled: true }).first('plugin_id');
      if (!enabled) return 0;
      const now = this.now();
      await trx('plugin_dispatch').where({ plugin_id: pluginId, lease_owner: this.owner }).update({ lease_expires_at: now + (this.options.leaseMs ?? DEFAULT_LEASE_MS) });
      return trx('plugin_deliveries').where({ id: row.id, status: row.status, attempt: row.attempt }).update({ status: 'running', attempt, started_at: now, finished_at: null });
    });
    if (marked !== 1) throw new Stopped();
    installation.attempts++;
    let run: PluginHandlerRun;
    try {
      run = await (this.options.run ?? runPluginHandler)(installation.target, row.handler!, { kind: 'event', event, deliveryId: row.delivery_id, attempt, ...(manual ? { manual: true } : {}) }, { ...this.options, database: this.database });
    } catch (error) {
      // The runner never throws; a replacement that does still only fails this attempt.
      run = { outcome: 'failed', timedOut: false, durationMs: 0, error: error instanceof Error ? error.message : 'The handler failed', logs: [] };
    }
    const now = this.now();
    // A permanent failure is not retried; a handler's Retry-After replaces the scheduled wait (the attempt still counts).
    const { status, nextAttemptAt } = attemptOutcome(run, attempt, { delays: this.delays, now, final: manual });
    const health: { notice: boolean; paused: boolean } = { notice: false, paused: false };
    await this.database.transaction(async trx => {
      // A dispatcher that lost the lease while the handler ran records nothing: the lease holder delivers it again, with the same id.
      const state = await trx('plugin_dispatch').where({ plugin_id: pluginId, lease_owner: this.owner }).first() as PluginDispatchRow | undefined;
      if (!state) throw new LeaseLost();
      await trx('plugin_deliveries').where({ id: row.id }).update({
        status, manual: false, finished_at: now, duration_ms: run.durationMs, timed_out: run.timedOut, error: clipError(run.error), logs: storedLogs(run.logs),
        next_attempt_at: nextAttemptAt,
      });
      Object.assign(health, await this.recordHealth(trx, state, run, now));
    });
    if (health.notice) await this.sendNotices(pluginId);
    if (health.paused) throw new Stopped();
    return status;
  }

  /** Send the Degraded notifications owed (of one installation); after a failure, passes try again after `NOTICE_RETRY_MS`. */
  private async sendNotices(pluginId?: string): Promise<void> {
    const sent = await sendPendingDegradedNotices(this.database, this.options.notify ?? notifyAdministratorsOfDegradedPlugin(this.database), pluginId)
      .catch((error: unknown) => {
        logger.warn({ pluginId, error: error instanceof Error ? error.message : String(error) }, '[plugins] Could not read the Degraded notifications owed');
        return false;
      });
    if (!sent) this.noticesDue = this.now() + NOTICE_RETRY_MS;
  }

  /**
   * Count the attempt into the installation's health; returns whether it just
   * became Degraded and whether it is paused now. Becoming Degraded queues the
   * notification owed in the same write, behind any earlier one not sent yet,
   * so a failed send or a crash before it leaves it to be sent again.
   */
  private async recordHealth(trx: Knex.Transaction, state: PluginDispatchRow, run: PluginHandlerRun, now: number): Promise<{ notice: boolean; paused: boolean }> {
    const where = { plugin_id: state.plugin_id };
    if (run.outcome === 'succeeded') {
      await trx('plugin_dispatch').where(where).update({ consecutive_failures: 0, degraded_at: null, updated_at: now });
      return { notice: false, paused: state.paused_at !== null };
    }
    const failures = Number(state.consecutive_failures) + 1;
    const becomesDegraded = state.degraded_at === null && failures >= this.degradedAfter;
    const error = clipError(run.error);
    const notice: PluginDegradedNotice = { pluginId: state.plugin_id, installedAt: Number(state.installed_at), degradedAt: now, consecutiveFailures: failures, lastError: error };
    await trx('plugin_dispatch').where(where).update({
      consecutive_failures: failures, last_error: error, last_error_at: now, updated_at: now,
      // Queued after any notice still owed from an earlier transition (`state` was read in this transaction).
      ...(becomesDegraded ? { degraded_at: now, degraded_notice: owedNoticesWith(state.degraded_notice, notice) } : {}),
      ...(state.paused_at === null && failures >= this.pauseAfter ? { paused_at: now } : {}),
    });
    const paused = state.paused_at !== null || failures >= this.pauseAfter;
    if (paused && state.paused_at === null) logger.warn({ pluginId: state.plugin_id, failures }, '[plugins] Event deliveries paused after repeated failures');
    return { notice: becomesDegraded, paused };
  }
}
