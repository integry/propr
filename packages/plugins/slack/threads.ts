import type { PluginContext, PluginJsonValue } from '@propr/shared';

/**
 * What app mode remembers in `ctx.state`:
 *
 * - `thread:<owner/repo>#<n>` (a pull request) and `thread:<owner/repo>!<n>`
 *   (an issue): `{ c: channel, t: thread ts, at }`, the Slack thread updates
 *   about it go to. An issue created from a mention maps to the mention's
 *   thread; its pull request then maps to the same thread. At most
 *   `MAX_THREADS` are kept; the oldest are forgotten first.
 * - `mentions`: the recent mentions handled, by `<channel>:<ts>` of the Slack
 *   message, so a retry of the same Slack event (or a second event for the same
 *   message) creates no second issue.
 */

export interface ThreadRef { [key: string]: PluginJsonValue; c: string; t: string; at: number }
export const MAX_THREADS = 150;
const EVICT = 30;
const THREAD_PREFIX = 'thread:';
const KEY_LIMIT = 200;

const threadKey = (repository: string, number: number, kind: 'pull_request' | 'issue') =>
  `${THREAD_PREFIX}${repository.toLowerCase()}${kind === 'pull_request' ? '#' : '!'}${number}`;
const isThread = (value: unknown): value is ThreadRef =>
  !!value && typeof value === 'object' && typeof (value as ThreadRef).c === 'string' && typeof (value as ThreadRef).t === 'string';

/** The thread of the pull request, else of the issue; with the key it came from. */
export async function findThread(ctx: PluginContext, repository: string, prNumber: number | null, issueNumber: number | null): Promise<{ thread: ThreadRef; via: 'pull_request' | 'issue' } | null> {
  for (const [kind, number] of [['pull_request', prNumber], ['issue', issueNumber]] as const) {
    if (number === null) continue;
    const key = threadKey(repository, number, kind);
    if (key.length > KEY_LIMIT) continue;
    const value = await ctx.state.get(key);
    if (isThread(value)) return { thread: value, via: kind };
  }
  return null;
}

/** Remember the thread of a pull request or an issue, forgetting the oldest when there are too many. */
export async function rememberThread(ctx: PluginContext, repository: string, number: number, kind: 'pull_request' | 'issue', channel: string, ts: string): Promise<void> {
  const key = threadKey(repository, number, kind);
  if (key.length > KEY_LIMIT || !ts) return;
  const existing = await ctx.state.keys(THREAD_PREFIX);
  if (!existing.includes(key) && existing.length >= MAX_THREADS) {
    const aged = await Promise.all(existing.map(async k => ({ k, at: Number(((await ctx.state.get(k)) as ThreadRef | undefined)?.at ?? 0) })));
    aged.sort((a, b) => a.at - b.at);
    for (const { k } of aged.slice(0, EVICT)) await ctx.state.delete(k);
  }
  await ctx.state.set(key, { c: channel, t: ts, at: Date.now() });
}

export async function forgetThread(ctx: PluginContext, repository: string, number: number, kind: 'pull_request' | 'issue'): Promise<void> {
  const key = threadKey(repository, number, kind);
  if (key.length <= KEY_LIMIT) await ctx.state.delete(key);
}

/**
 * A handled mention. `s`: `pending` while the issue is being created (a retry
 * then cannot tell whether it was, and creates nothing), `created` once it was,
 * `replied` once the thread reply was posted, `refused` or `ignored` when no
 * issue was to be created and the reply (if any) was posted.
 */
export type MentionStatus = 'pending' | 'created' | 'replied' | 'refused' | 'ignored';
export interface MentionRecord { m: string; s: MentionStatus; at: number; r?: string; n?: number; u?: string }
const MENTIONS = 'mentions';
const MAX_MENTIONS = 50;
const MENTION_BYTES = 12 * 1024;

export async function readMention(ctx: PluginContext, message: string): Promise<MentionRecord | undefined> {
  const list = ((await ctx.state.get(MENTIONS)) ?? []) as unknown as MentionRecord[];
  return Array.isArray(list) ? list.find(entry => entry?.m === message) : undefined;
}

/** Write (or replace) the record of one mention; the oldest records are dropped to stay within the limits. */
export async function writeMention(ctx: PluginContext, record: Omit<MentionRecord, 'at'>): Promise<void> {
  const current = ((await ctx.state.get(MENTIONS)) ?? []) as unknown as MentionRecord[];
  const list = (Array.isArray(current) ? current : []).filter(entry => entry?.m !== record.m);
  list.push({ ...record, at: Date.now() } as MentionRecord);
  while (list.length > MAX_MENTIONS || (list.length > 1 && Buffer.byteLength(JSON.stringify(list)) > MENTION_BYTES)) list.shift();
  await ctx.state.set(MENTIONS, list as unknown as PluginJsonValue);
}

export async function deleteMention(ctx: PluginContext, message: string): Promise<void> {
  const current = ((await ctx.state.get(MENTIONS)) ?? []) as unknown as MentionRecord[];
  if (Array.isArray(current)) await ctx.state.set(MENTIONS, current.filter(entry => entry?.m !== message) as unknown as PluginJsonValue);
}
