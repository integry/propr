import {
  PLUGIN_DELIVERY_RETRY_DELAYS_MS, PLUGIN_HANDLER_TIMEOUT_MS, PLUGIN_RETRY_AFTER_LIMITS_MS,
  type PluginContext, type PluginJsonValue,
} from '@propr/shared';

/**
 * The mentions app mode handled, in `ctx.state`, so a retry of a Slack event
 * (a Slack retry is a new delivery; a delivery is retried by ProPR too)
 * creates no second issue.
 *
 * A record must outlive every delivery that could still bring its message to
 * creation. So a mention is only taken in for `MENTION_ACCEPT_MS` after it
 * was posted (by the time ProPR received the request, which a retry of the
 * delivery keeps), and its record is kept `MENTION_KEEP_MS` past the later of
 * that time and its last write: the accept window plus the longest a delivery
 * can keep being retried. Older events are ignored before any record is read,
 * so one whose record was removed never reaches creation again.
 *
 * Records that stand for an issue (`pending`, `created`, `replied`) are never
 * dropped before they expire. When there is no room for a new one, refused
 * and ignored records (which only spare a repeated reply) are dropped first,
 * and failing that the mention is not taken in (`writeMention` returns
 * false) rather than forget one that is still needed. Room is counted with
 * every unfinished record at its largest, so recording an issue's number and
 * link never needs more than what was admitted.
 *
 * The records are spread over `MENTION_SHARDS` keys (`mentions:<n>`) by
 * message, each at most `MENTION_BYTES`.
 */

/** A handled mention. `s`: `pending` while the issue is being created (a retry then cannot tell whether it was, and creates nothing), `created` once it was, `replied` once the thread reply was posted, `refused` or `ignored` when no issue was to be created and the reply (if any) was posted. */
export type MentionStatus = 'pending' | 'created' | 'replied' | 'refused' | 'ignored';
export interface MentionRecord { m: string; s: MentionStatus; at: number; r?: string; n?: number; u?: string }

/** How long after a Slack message was posted a mention in it is taken in. Slack retries a failed event within minutes. */
export const MENTION_ACCEPT_MS = 60 * 60_000;
/** The longest a delivery is retried: every scheduled retry at the longest wait a handler may ask for, each attempt running to its timeout. */
const DELIVERY_SPAN_MS = PLUGIN_DELIVERY_RETRY_DELAYS_MS.reduce(sum => sum + PLUGIN_RETRY_AFTER_LIMITS_MS.max, 0) + (PLUGIN_DELIVERY_RETRY_DELAYS_MS.length + 1) * PLUGIN_HANDLER_TIMEOUT_MS;
/** How long a record is kept: the accept window and the delivery span, with an hour of margin. */
export const MENTION_KEEP_MS = MENTION_ACCEPT_MS + DELIVERY_SPAN_MS + 60 * 60_000;
export const MENTION_SHARDS = 4;
const MENTION_BYTES = 12 * 1024;
/** The longest issue link kept; a longer one is not stored (the reply then names the issue without a link). */
const URL_CHARS = 200;

const holdsIssue = (status: MentionStatus) => status === 'pending' || status === 'created' || status === 'replied';
/** The Slack message time of `<channel>:<ts>`, in milliseconds; 0 when unreadable. */
const messageTime = (message: string) => { const ms = Number(message.slice(message.indexOf(':') + 1)) * 1000; return Number.isFinite(ms) ? ms : 0; };

/** Whether a mention posted at `ts` (Slack's message ts) and received at `receivedAt` is too old to be taken in. */
export const mentionExpired = (ts: string, receivedAt: number): boolean => receivedAt - messageTime(`:${ts}`) > MENTION_ACCEPT_MS;

const expired = (entry: MentionRecord, now: number) => Math.max(Number(entry.at) || 0, messageTime(entry.m)) + MENTION_KEEP_MS <= now;
/** The bytes an entry may come to take: an unfinished one with the largest issue number and link. */
const reserved = (entry: MentionRecord) => Buffer.byteLength(JSON.stringify(entry.s === 'pending' || entry.s === 'created'
  ? { ...entry, s: 'replied', n: entry.n ?? 999_999_999, u: entry.u ?? 'x'.repeat(URL_CHARS) } : entry)) + 1;
const fits = (list: MentionRecord[]) => list.reduce((sum, entry) => sum + reserved(entry), 1) <= MENTION_BYTES;

/** The shard key of a message (FNV-1a). */
export function mentionKey(message: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < message.length; i += 1) hash = Math.imul(hash ^ message.charCodeAt(i), 0x01000193);
  return `mentions:${(hash >>> 0) % MENTION_SHARDS}`;
}

async function load(ctx: PluginContext, message: string): Promise<MentionRecord[]> {
  const value = await ctx.state.get(mentionKey(message));
  return Array.isArray(value) ? (value as unknown as MentionRecord[]).filter(entry => !!entry && typeof entry === 'object' && typeof entry.m === 'string') : [];
}

export async function readMention(ctx: PluginContext, message: string): Promise<MentionRecord | undefined> {
  return (await load(ctx, message)).find(entry => entry.m === message);
}

/**
 * Write (or replace) the record of one mention, dropping expired records.
 * Returns false, writing nothing, when a new record finds no room even after
 * refused and ignored records are dropped; a record that stands for an issue
 * is never dropped. Replacing an unfinished record always succeeds.
 */
export async function writeMention(ctx: PluginContext, record: Omit<MentionRecord, 'at'>): Promise<boolean> {
  const now = Date.now();
  const current = await load(ctx, record.m);
  const previous = current.find(entry => entry.m === record.m);
  const next = { ...record, at: now } as MentionRecord;
  if (next.u !== undefined && next.u.length > URL_CHARS) delete next.u;
  const list = [...current.filter(entry => entry.m !== record.m && !expired(entry, now)), next];
  while (!fits(list)) {
    const spare = list.findIndex(entry => entry !== next && !holdsIssue(entry.s));
    if (spare < 0) break;
    list.splice(spare, 1);
  }
  // An unfinished record's room was counted when it was admitted: its update is written however full the list is.
  if (!fits(list) && !(previous && holdsIssue(previous.s) && holdsIssue(next.s))) return false;
  await ctx.state.set(mentionKey(record.m), list as unknown as PluginJsonValue);
  return true;
}

export async function deleteMention(ctx: PluginContext, message: string): Promise<void> {
  const current = await load(ctx, message);
  if (current.some(entry => entry.m === message)) await ctx.state.set(mentionKey(message), current.filter(entry => entry.m !== message) as unknown as PluginJsonValue);
}
