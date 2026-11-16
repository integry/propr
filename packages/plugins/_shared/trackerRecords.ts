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
 *   request linked to it and which sync-back actions were done, so a
 *   redelivered event posts no second comment.
 *
 * Shards are chosen by ticket id (FNV-1a) and hold at most `SHARD_BYTES`
 * each, within the state limits (`PLUGIN_STATE_LIMITS`). Ticket records are
 * kept `TICKET_KEEP_MS`; a full shard forgets its oldest finished record
 * first. Progress records are forgotten oldest first, those of tickets whose
 * pull request merged or closed before the others: losing one at worst
 * repeats a comment.
 */

export type TicketStatus = 'pending' | 'created';
export interface TicketRecord { t: string; k: string; r: string; s: TicketStatus; n?: number; at: number }
export interface ProgressRecord { t: string; p?: number; d: string[]; at: number }

export const TICKET_SHARDS = 8;
export const PROGRESS_SHARDS = 6;
export const SHARD_BYTES = 15 * 1024;
/** How long a handed-off ticket is remembered: re-adding the trigger label within this time creates nothing. */
export const TICKET_KEEP_MS = 365 * 24 * 60 * 60_000;
/** Done markers kept per ticket; the oldest go first. */
const DONE_LIMIT = 24;
/** Done markers that end a ticket's sync: its pull request merged or closed. */
export const FINISHED_MARKERS = /^(merged|closed):/;

function shardOf(id: string, shards: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return (hash >>> 0) % shards;
}
export const ticketKey = (id: string) => `tickets:${shardOf(id, TICKET_SHARDS)}`;
export const progressKey = (id: string) => `sync:${shardOf(id, PROGRESS_SHARDS)}`;
const bytes = (list: unknown[]) => Buffer.byteLength(JSON.stringify(list));
const oldestFirst = <T extends { at: number }>(list: T[]) => [...list].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));

async function loadList<T extends { t: string }>(ctx: PluginContext, key: string): Promise<T[]> {
  const value = await ctx.state.get(key);
  return Array.isArray(value) ? (value as unknown as T[]).filter(entry => !!entry && typeof entry === 'object' && typeof entry.t === 'string') : [];
}

const sameRepository = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function readTicket(ctx: PluginContext, id: string): Promise<TicketRecord | undefined> {
  return (await loadList<TicketRecord>(ctx, ticketKey(id))).find(entry => entry.t === id);
}

/**
 * Write (or replace) a ticket record. Expired records are dropped; when the
 * shard is still full, the oldest created records go first. A pending record
 * is never dropped: with no room left the write fails the delivery, to be
 * retried later, rather than forget a ticket whose issue may exist.
 */
export async function writeTicket(ctx: PluginContext, record: Omit<TicketRecord, 'at'>): Promise<void> {
  const now = Date.now();
  const key = ticketKey(record.t);
  const next = { ...record, at: now } as TicketRecord;
  const list = [...oldestFirst((await loadList<TicketRecord>(ctx, key)).filter(entry => entry.t !== record.t && now - Number(entry.at || 0) < TICKET_KEEP_MS)), next];
  while (bytes(list) > SHARD_BYTES) {
    const oldest = list.findIndex(entry => entry !== next && entry.s === 'created');
    if (oldest < 0) throw new PluginDeliveryError('Too many tickets are being handed to ProPR at once to remember another one; it is retried later', { retryAfterMs: 10 * 60_000 });
    list.splice(oldest, 1);
  }
  await ctx.state.set(key, list as unknown as PluginJsonValue);
}

export async function deleteTicket(ctx: PluginContext, id: string): Promise<void> {
  const key = ticketKey(id);
  const list = await loadList<TicketRecord>(ctx, key);
  if (list.some(entry => entry.t === id)) await ctx.state.set(key, list.filter(entry => entry.t !== id) as unknown as PluginJsonValue);
}

/** The created ticket whose GitHub issue is `repository#number`, if any. */
export async function findTicketByIssue(ctx: PluginContext, repository: string, number: number): Promise<TicketRecord | undefined> {
  for (let shard = 0; shard < TICKET_SHARDS; shard += 1) {
    const found = (await loadList<TicketRecord>(ctx, `tickets:${shard}`)).find(entry => entry.s === 'created' && entry.n === number && sameRepository(entry.r, repository));
    if (found) return found;
  }
  return undefined;
}

export async function readProgress(ctx: PluginContext, id: string): Promise<ProgressRecord> {
  return (await loadList<ProgressRecord>(ctx, progressKey(id))).find(entry => entry.t === id) ?? { t: id, d: [], at: 0 };
}

/** Write a ticket's progress; a full shard forgets finished tickets' progress first, then the oldest. */
export async function writeProgress(ctx: PluginContext, record: Omit<ProgressRecord, 'at'>): Promise<void> {
  const key = progressKey(record.t);
  const next = { ...record, d: record.d.slice(-DONE_LIMIT), at: Date.now() } as ProgressRecord;
  const list = [...oldestFirst((await loadList<ProgressRecord>(ctx, key)).filter(entry => entry.t !== record.t)), next];
  while (bytes(list) > SHARD_BYTES && list.length > 1) {
    const finished = list.findIndex(entry => entry !== next && entry.d.some(done => FINISHED_MARKERS.test(done)));
    list.splice(finished >= 0 ? finished : 0, 1);
  }
  await ctx.state.set(key, list as unknown as PluginJsonValue);
}

/** The ticket whose linked pull request is `repository#number`, if any. */
export async function findTicketByPullRequest(ctx: PluginContext, repository: string, number: number): Promise<TicketRecord | undefined> {
  for (let shard = 0; shard < PROGRESS_SHARDS; shard += 1) {
    for (const entry of (await loadList<ProgressRecord>(ctx, `sync:${shard}`)).filter(p => p.p === number)) {
      const ticket = await readTicket(ctx, entry.t);
      if (ticket?.s === 'created' && sameRepository(ticket.r, repository)) return ticket;
    }
  }
  return undefined;
}
