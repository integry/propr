import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestPluginContext } from '../testing/index.js';
import { LINK_SHARDS, LINK_STEPS, PENDING_KEEP_MS, findLink, linkKey, markStep, readLink, withTicketLock, writeLink } from '../_shared/trackerLinks.js';
import { branchIssueNumber, syncKind } from '../_shared/tracker.js';

/** The ticket-to-issue links shared by the tracker plugins (`_shared/trackerLinks.ts`). */

test('links are sharded by ticket, found by issue or pull request, and a full shard forgets the oldest created link but never a recent pending one', async () => {
  const { ctx, state } = createTestPluginContext();
  assert.ok(Number(/^links:(\d+)$/.exec(linkKey('ticket-1'))?.[1]) < LINK_SHARDS);
  await writeLink(ctx, { t: 'ticket-1', k: 'ENG-1', s: 'created', r: 'Acme/Api', n: 5, p: [9] });
  assert.equal((await findLink(ctx, 'acme/api', { issue: 5 }))?.t, 'ticket-1');
  assert.equal((await findLink(ctx, 'acme/api', { pullRequest: 9 }))?.t, 'ticket-1');
  assert.equal(await findLink(ctx, 'acme/web', { issue: 5 }), undefined);

  // Fill one shard: tickets whose ids hash to the same key as "pending-recent".
  const key = linkKey('pending-recent');
  await writeLink(ctx, { t: 'pending-recent', k: 'ENG-2', s: 'pending', r: 'acme/api' });
  const same: string[] = [];
  for (let i = 0; same.length < 200; i += 1) if (linkKey(`t-${i}`) === key) same.push(`t-${i}`);
  for (const [index, id] of same.entries()) assert.equal(await writeLink(ctx, { t: id, k: `ENG-${index + 10}`, s: 'created', r: 'acme/api', n: index + 10, d: ['created:comment'] }), true);
  assert.ok(Buffer.byteLength(JSON.stringify(state.get(key))) <= 14 * 1024);
  assert.equal((await readLink(ctx, 'pending-recent'))?.s, 'pending', 'a recent pending link is kept');
  assert.equal(await readLink(ctx, same[0]), undefined, 'the oldest created link was forgotten');
  assert.equal((await readLink(ctx, same[199]))?.n, 209);

  const old = createTestPluginContext({ state: { [key]: [{ t: 'stale', k: 'ENG-3', s: 'pending', r: 'acme/api', at: Date.now() - PENDING_KEEP_MS - 1 }] } });
  for (const id of same) await writeLink(old.ctx, { t: id, k: 'ENG-9', s: 'created', r: 'acme/api', n: 1 });
  assert.equal(await readLink(old.ctx, 'stale'), undefined, 'a pending link left long ago may be forgotten');
});

test('steps are capped, the ticket lock runs one delivery at a time, and branches and events map as expected', async () => {
  const { ctx } = createTestPluginContext();
  await writeLink(ctx, { t: 'x', k: 'ENG-1', s: 'created', r: 'acme/api', n: 1 });
  let link = (await readLink(ctx, 'x'))!;
  for (let i = 0; i < LINK_STEPS + 5; i += 1) link = await markStep(ctx, link, `s${i}`);
  assert.equal((await readLink(ctx, 'x'))!.d!.length, LINK_STEPS);
  const order: string[] = [];
  await Promise.all([1, 2, 3].map(n => withTicketLock('x', async () => { order.push(`start${n}`); await new Promise(r => setTimeout(r, 5)); order.push(`end${n}`); })));
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
  assert.deepEqual(['41/claude-x', '41-fix', 'feature/41', 'main'].map(branchIssueNumber), [41, 41, null, null]);
  assert.equal(syncKind({ domain: 'pull_request', type: 'review_scored', payload: { score: 80, goal: 80, goalReached: null } }), 'review_goal_reached');
  assert.equal(syncKind({ domain: 'pull_request', type: 'head_changed', payload: {} }), null);
});
