import type { PluginContext, PluginJsonValue } from '@propr/shared';

/**
 * Ticket-to-issue links of the issue tracker plugins (Linear, Jira), kept in
 * `ctx.state`: which GitHub issue a ticket created, the pull requests found
 * for that issue, and the sync-back steps already done, so that one ticket
 * creates at most one issue (however often its trigger fires, and across
 * webhook retries) and no update is posted to the ticket twice.
 *
 * Links are spread over `LINK_SHARDS` keys (`links:<n>`) by ticket id, each at
 * most `LINK_BYTES`. When a shard is full the links touched longest ago are
 * forgotten first; a `pending` link (its issue being created) is kept unless
 * it is older than `PENDING_KEEP_MS`. A forgotten ticket's trigger would
 * create a new issue, so the store holds well over a thousand tickets; the
 * READMEs say so.
 */

/**
 * One ticket's link. `t` the ticket id, `k` its human key (`ENG-123`), `s`
 * `pending` while the issue is being created (a retry then creates nothing)
 * or `created`; `r`/`n` the repository and issue, `p` its pull requests, `g`
 * the tracker scope used for state moves (a Linear team id), `d` the
 * sync-back steps done (newest last) and `at` the last write.
 */
export interface TrackerLink { t: string; k: string; s: 'pending' | 'created'; r: string; n?: number; p?: number[]; g?: string; d?: string[]; at: number }

export const LINK_SHARDS = 12;
const LINK_BYTES = 14 * 1024;
/** Sync-back steps remembered per link; the oldest are forgotten first. */
export const LINK_STEPS = 24;
/** Pull requests remembered per link. */
const LINK_PULL_REQUESTS = 8;
/** A pending link older than this was left by a creation that was interrupted long ago; it may be forgotten when a shard is full. */
export const PENDING_KEEP_MS = 7 * 24 * 60 * 60_000;

/** The shard key of a ticket (FNV-1a of its id). */
export function linkKey(ticketId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < ticketId.length; i += 1) hash = Math.imul(hash ^ ticketId.charCodeAt(i), 0x01000193);
  return `links:${(hash >>> 0) % LINK_SHARDS}`;
}

const isLink = (value: unknown): value is TrackerLink => {
  const link = value as TrackerLink | null;
  return !!link && typeof link === 'object' && typeof link.t === 'string' && typeof link.r === 'string' && (link.s === 'pending' || link.s === 'created');
};

async function shard(ctx: PluginContext, key: string): Promise<TrackerLink[]> {
  const value = await ctx.state.get(key);
  return Array.isArray(value) ? (value as unknown[]).filter(isLink) : [];
}

const bytes = (links: TrackerLink[]) => Buffer.byteLength(JSON.stringify(links));

export async function readLink(ctx: PluginContext, ticketId: string): Promise<TrackerLink | undefined> {
  return (await shard(ctx, linkKey(ticketId))).find(link => link.t === ticketId);
}

/** The created link of an issue, or of a pull request found for one, in `repository` (compared without letter case). */
export async function findLink(ctx: PluginContext, repository: string, match: { issue?: number | null; pullRequest?: number | null }): Promise<TrackerLink | undefined> {
  const name = repository.toLowerCase();
  for (let index = 0; index < LINK_SHARDS; index += 1) {
    const found = (await shard(ctx, `links:${index}`)).find(link => link.s === 'created' && link.r.toLowerCase() === name
      && ((match.issue != null && link.n === match.issue) || (match.pullRequest != null && (link.p ?? []).includes(match.pullRequest))));
    if (found) return found;
  }
  return undefined;
}

/**
 * Write (or replace) a ticket's link, forgetting the links touched longest
 * ago when its shard is full (a recent pending link is never forgotten).
 * Returns false, writing nothing, when there is still no room.
 */
export async function writeLink(ctx: PluginContext, link: Omit<TrackerLink, 'at'>): Promise<boolean> {
  const key = linkKey(link.t);
  const now = Date.now();
  const next: TrackerLink = { ...link, at: now, ...(link.p ? { p: link.p.slice(-LINK_PULL_REQUESTS) } : {}), ...(link.d ? { d: link.d.slice(-LINK_STEPS) } : {}) };
  const others = (await shard(ctx, key)).filter(entry => entry.t !== link.t).sort((a, b) => a.at - b.at);
  const list = [...others, next];
  while (bytes(list) > LINK_BYTES) {
    const spare = list.findIndex(entry => entry !== next && (entry.s === 'created' || now - entry.at > PENDING_KEEP_MS));
    if (spare < 0) return false;
    list.splice(spare, 1);
  }
  await ctx.state.set(key, list as unknown as PluginJsonValue);
  return true;
}

export async function deleteLink(ctx: PluginContext, ticketId: string): Promise<void> {
  const key = linkKey(ticketId);
  const list = await shard(ctx, key);
  if (list.some(link => link.t === ticketId)) await ctx.state.set(key, list.filter(link => link.t !== ticketId) as unknown as PluginJsonValue);
}

/** Whether a sync-back step was done for this link. */
export const stepDone = (link: TrackerLink, step: string): boolean => (link.d ?? []).includes(step);

/** Record a step as done, reading the link again so a concurrent write is not undone. */
export async function markStep(ctx: PluginContext, link: TrackerLink, step: string): Promise<TrackerLink> {
  const current = (await readLink(ctx, link.t)) ?? link;
  const next = { ...current, d: [...(current.d ?? []).filter(done => done !== step), step] };
  await writeLink(ctx, next);
  return { ...next, at: Date.now() };
}

/** Remember a pull request found for the link's issue. */
export async function addPullRequest(ctx: PluginContext, link: TrackerLink, pullRequest: number): Promise<TrackerLink> {
  const current = (await readLink(ctx, link.t)) ?? link;
  if ((current.p ?? []).includes(pullRequest)) return current;
  const next = { ...current, p: [...(current.p ?? []), pullRequest] };
  await writeLink(ctx, next);
  return { ...next, at: Date.now() };
}

const locks = new Map<string, Promise<unknown>>();
/**
 * Run `work` for one ticket at a time in this process: two deliveries about
 * the same ticket (Linear's create and update webhooks arriving together)
 * cannot both find no link and both create an issue.
 */
export async function withTicketLock<T>(ticketId: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(ticketId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const settled = run.catch(() => undefined);
  locks.set(ticketId, settled);
  try { return await run; } finally { if (locks.get(ticketId) === settled) locks.delete(ticketId); }
}
