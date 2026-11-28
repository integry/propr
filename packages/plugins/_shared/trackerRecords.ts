import { PluginDeliveryError, type PluginContext, type PluginJsonValue } from '@propr/shared';

/**
 * What an issue tracker plugin (Linear, Jira) remembers in `ctx.state`, in
 * two sets of shards so the inbound webhook and the event subscriptions never
 * write the same key:
 *
 * - `tickets:<0-7>`: one record per ticket handed to ProPR, written only by
 *   the webhook handler: the ticket id, its reference (`ENG-123`), the
 *   repository and the GitHub issue created for it. A ticket with a record
 *   never creates a second issue: this is the de-duplication by ticket id,
 *   across webhook retries and replays. `pending` while the issue is being
 *   created (a retry then cannot tell whether it was, and creates nothing).
 * - `sync:<0-5>`: per ticket, written only by the event handler: the pull
 *   requests linked to it (every one, not just the latest, so an earlier
 *   pull request that merges or closes after a later one opened still syncs
 *   back) and which sync-back actions were done, so a redelivered event posts
 *   no second comment. The done markers are a rolling history (`d`); the
 *   merge and close markers of every pull request still linked are also kept
 *   apart (`f`), however many markers later ones added, so a retried opening
 *   delivery never moves a ticket back after its merge, and a finished pull
 *   request is still known to be finished.
 *
 * Shards are chosen by ticket id (FNV-1a) and hold at most `SHARD_BYTES`
 * each, within the state limits (`PLUGIN_STATE_LIMITS`). Ticket records are
 * kept `TICKET_KEEP_MS`; a full shard forgets its oldest finished record
 * first, and a pending record is admitted only with room for it to finish
 * (its issue number), so recording a created issue never fails for want of
 * space. Progress records are forgotten oldest first, those of tickets whose
 * every linked pull request merged or closed before the others: losing one at
 * worst repeats a comment.
 *
 * Every change of a shard is one `ctx.state.update`: deliveries handled at
 * the same time (in other processes too) for tickets sharing a shard never
 * overwrite each other's records, and of two deliveries for one ticket only
 * one reserves it.
 */

export type TicketStatus = 'pending' | 'created';
export interface TicketRecord { t: string; k: string; r: string; s: TicketStatus; n?: number; at: number }
/**
 * `p`: the ticket's linked pull requests, oldest first. `d`: the done markers,
 * the latest `DONE_LIMIT`. `f`: the merge and close markers of the linked pull
 * requests, kept while they are linked (see `doneMarkers`).
 */
export interface ProgressRecord { t: string; p?: number[]; d: string[]; f?: string[]; at: number }

export const TICKET_SHARDS = 8;
export const PROGRESS_SHARDS = 6;
export const SHARD_BYTES = 15 * 1024;
/** How long a handed-off ticket is remembered: re-adding the trigger label within this time creates nothing. */
export const TICKET_KEEP_MS = 365 * 24 * 60 * 60_000;
/** Done markers kept per ticket; the oldest go first. */
const DONE_LIMIT = 24;
/** Pull requests linked per ticket; past this, finished ones are forgotten first, then the oldest. */
export const PULL_LIMIT = 10;
/**
 * The largest issue number a pending record is given room for: JSON writes a
 * safe integer in at most this many characters.
 */
const ISSUE_NUMBER_ROOM = Number.MAX_SAFE_INTEGER;

function shardOf(id: string, shards: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return (hash >>> 0) % shards;
}
export const ticketKey = (id: string) => `tickets:${shardOf(id, TICKET_SHARDS)}`;
export const progressKey = (id: string) => `sync:${shardOf(id, PROGRESS_SHARDS)}`;
const bytes = (list: unknown[]) => Buffer.byteLength(JSON.stringify(list));
const oldestFirst = <T extends { at: number }>(list: T[]) => [...list].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));

const asList = <T extends { t: string }>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]).filter(entry => !!entry && typeof entry === 'object' && typeof entry.t === 'string') : [];
const loadList = async <T extends { t: string }>(ctx: PluginContext, key: string): Promise<T[]> => asList<T>(await ctx.state.get(key));
/** Replace a shard's list atomically: `change` gets the current list and returns the new one, or undefined for no change. */
async function updateList<T extends { t: string }>(ctx: PluginContext, key: string, change: (list: T[]) => T[] | undefined): Promise<void> {
  await ctx.state.update(key, current => change(asList<T>(current)) as unknown as PluginJsonValue | undefined);
}

const sameRepository = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The pull requests a progress record links, whatever was stored. */
export function linkedPulls(progress: { p?: unknown }): number[] {
  const value = Array.isArray(progress.p) ? progress.p : [progress.p];
  return value.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);
}
/** A merge or close marker (`merged:55:move`): whether a pull request finished, and whether its opening move is superseded. */
const PULL_FLAG = /^(?:merged|closed):(\d+):/;
/**
 * Every done marker of a ticket: the rolling history and the merge and close
 * markers of its linked pull requests, which outlive that history.
 */
export function doneMarkers(progress: { d?: unknown; f?: unknown }): string[] {
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((m): m is string => typeof m === 'string') : []);
  return [...new Set([...strings(progress.f), ...strings(progress.d)])];
}
/** The merge and close markers among `markers` of the pull requests in `pulls`. */
const pullFlags = (markers: string[], pulls: number[]) => markers.filter(marker => {
  const pr = PULL_FLAG.exec(marker)?.[1];
  return pr !== undefined && pulls.includes(Number(pr));
});
/** Whether a pull request's merge or close was synced. */
const pullFinished = (done: string[], pr: number) => done.some(marker => marker.startsWith(`merged:${pr}:`) || marker.startsWith(`closed:${pr}:`));
/** Whether every pull request a ticket linked merged or closed: its sync is over. */
const progressFinished = (progress: ProgressRecord) => {
  const pulls = linkedPulls(progress);
  return pulls.length > 0 && pulls.every(pr => pullFinished(doneMarkers(progress), pr));
};

/**
 * The pull requests linked once `pr` is linked too, or undefined when it
 * already is. Past `PULL_LIMIT`, finished pull requests are forgotten first,
 * then the oldest.
 */
export function withPullRequest(progress: ProgressRecord, pr: number): number[] | undefined {
  const pulls = linkedPulls(progress);
  if (pulls.includes(pr)) return undefined;
  const next = [...pulls, pr];
  const done = doneMarkers(progress);
  while (next.length > PULL_LIMIT) {
    const finished = next.findIndex(n => n !== pr && pullFinished(done, n));
    next.splice(finished >= 0 ? finished : 0, 1);
  }
  return next;
}

export async function readTicket(ctx: PluginContext, id: string): Promise<TicketRecord | undefined> {
  return (await loadList<TicketRecord>(ctx, ticketKey(id))).find(entry => entry.t === id);
}

/**
 * A shard's size once every pending record in it is created: each counted
 * with the largest issue number it could get. Kept within `SHARD_BYTES` by
 * every write, so finishing a pending record (which only replaces it with its
 * created form) always fits, however many reservations are under way at once.
 */
const finishedBytes = (list: TicketRecord[]) => bytes(list.map(entry => (entry.s === 'pending' ? { ...entry, s: 'created', n: ISSUE_NUMBER_ROOM } : entry)));

/**
 * A shard's list with `record` written (or replaced). Expired records are
 * dropped; when the shard is still full, the oldest created records go first.
 * A pending record is never dropped: with no room left the write fails the
 * delivery, to be retried later, rather than forget a ticket whose issue may
 * exist. Room is measured with every pending record finished, so a new
 * reservation is refused (before its issue is created) rather than leave a
 * created issue unrecorded.
 */
function withTicket(current: TicketRecord[], record: Omit<TicketRecord, 'at'>): TicketRecord[] {
  const now = Date.now();
  const next = { ...record, at: now } as TicketRecord;
  const list = [...oldestFirst(current.filter(entry => entry.t !== record.t && now - Number(entry.at || 0) < TICKET_KEEP_MS)), next];
  while (finishedBytes(list) > SHARD_BYTES) {
    const oldest = list.findIndex(entry => entry !== next && entry.s === 'created');
    if (oldest < 0) throw new PluginDeliveryError('Too many tickets are being handed to ProPR at once to remember another one; it is retried later', { retryAfterMs: 10 * 60_000 });
    list.splice(oldest, 1);
  }
  return list;
}

/**
 * Reserve a ticket: record it as pending unless it already has a record, in
 * one atomic shard update. Returns the existing record (nothing written), or
 * undefined when this call reserved it.
 */
export async function reserveTicket(ctx: PluginContext, record: Omit<TicketRecord, 'at' | 's' | 'n'>): Promise<TicketRecord | undefined> {
  let seen: TicketRecord | undefined;
  await updateList<TicketRecord>(ctx, ticketKey(record.t), list => {
    seen = list.find(entry => entry.t === record.t);
    return seen ? undefined : withTicket(list, { ...record, s: 'pending' });
  });
  return seen;
}

/** Write (or replace) a ticket record, in one atomic shard update. */
export async function writeTicket(ctx: PluginContext, record: Omit<TicketRecord, 'at'>): Promise<void> {
  await updateList<TicketRecord>(ctx, ticketKey(record.t), list => withTicket(list, record));
}

export async function deleteTicket(ctx: PluginContext, id: string): Promise<void> {
  await updateList<TicketRecord>(ctx, ticketKey(id), list => (list.some(entry => entry.t === id) ? list.filter(entry => entry.t !== id) : undefined));
}

/**
 * The created ticket whose GitHub issue is `repository#number`, if any, and
 * otherwise the tickets of `repository` still pending: their issue is being
 * created, or was and is not recorded yet, so one of them may be this issue's
 * ticket. Each shard is read once and a ticket lives in one shard, so a
 * record finished during the lookup is seen pending or created, never neither.
 */
export async function findTicketByIssue(ctx: PluginContext, repository: string, number: number): Promise<{ ticket?: TicketRecord; pending: TicketRecord[] }> {
  const pending: TicketRecord[] = [];
  for (let shard = 0; shard < TICKET_SHARDS; shard += 1) {
    const list = (await loadList<TicketRecord>(ctx, `tickets:${shard}`)).filter(entry => sameRepository(entry.r, repository));
    const ticket = list.find(entry => entry.s === 'created' && entry.n === number);
    if (ticket) return { ticket, pending: [] };
    pending.push(...list.filter(entry => entry.s === 'pending'));
  }
  return { pending };
}

export async function readProgress(ctx: PluginContext, id: string): Promise<ProgressRecord> {
  return (await loadList<ProgressRecord>(ctx, progressKey(id))).find(entry => entry.t === id) ?? { t: id, d: [], at: 0 };
}

/**
 * Change a ticket's progress in one atomic shard update: `change` gets the
 * current progress and returns the new one, or undefined for no change. A
 * full shard forgets finished tickets' progress first, then the oldest. The
 * merge and close markers of the pull requests still linked are kept in `f`
 * whatever `change` returned for it, and dropped with their pull request.
 */
export async function updateProgress(ctx: PluginContext, id: string, change: (progress: ProgressRecord) => Omit<ProgressRecord, 'at'> | undefined): Promise<void> {
  await updateList<ProgressRecord>(ctx, progressKey(id), current => {
    const previous = current.find(entry => entry.t === id) ?? { t: id, d: [], at: 0 };
    const record = change(previous);
    if (!record) return undefined;
    const flags = pullFlags([...new Set([...doneMarkers(previous), ...doneMarkers(record)])], linkedPulls(record));
    const next = { ...record, t: id, d: record.d.slice(-DONE_LIMIT), at: Date.now() } as ProgressRecord;
    if (flags.length) next.f = flags; else delete next.f;
    const list = [...oldestFirst(current.filter(entry => entry.t !== id)), next];
    while (bytes(list) > SHARD_BYTES && list.length > 1) {
      const finished = list.findIndex(entry => entry !== next && progressFinished(entry));
      list.splice(finished >= 0 ? finished : 0, 1);
    }
    return list;
  });
}

/** The ticket that linked the pull request `repository#number` (its latest or an earlier one), if any. */
export async function findTicketByPullRequest(ctx: PluginContext, repository: string, number: number): Promise<TicketRecord | undefined> {
  for (let shard = 0; shard < PROGRESS_SHARDS; shard += 1) {
    for (const entry of (await loadList<ProgressRecord>(ctx, `sync:${shard}`)).filter(p => linkedPulls(p).includes(number))) {
      const ticket = await readTicket(ctx, entry.t);
      if (ticket?.s === 'created' && sameRepository(ticket.r, repository)) return ticket;
    }
  }
  return undefined;
}
