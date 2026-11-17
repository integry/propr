import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLUGIN_PROPR_LIMITS, PluginDeliveryError, type PluginJsonValue } from '@propr/shared';
import { createTestPluginContext } from '../testing/index.js';
import { ISSUE_BODY_BYTES, handOffTicket, inertQuote, ticketIssueBody, type TicketHandOff } from '../_shared/trackerIssue.js';
import { PULL_LIMIT, SHARD_BYTES, doneMarkers, findTicketByPullRequest, linkedPulls, progressKey, readProgress, readTicket, ticketKey, updateProgress, withPullRequest, type ProgressRecord, type TicketRecord } from '../_shared/trackerRecords.js';

/**
 * The shared issue tracker helper (Linear, Jira) at its edges: deliveries
 * handled at the same time sharing a state shard, and descriptions whose
 * escaping makes them grow past the issue body limit.
 */

const handOff = (id: string, description = 'Fix it'): TicketHandOff => ({
  id, reference: `ENG-${id.slice(-4)}`, url: `https://linear.app/acme/issue/ENG-${id.slice(-4)}`, title: 'A ticket', description,
  repository: 'acme/api', githubLabel: 'AI', service: 'Linear', trigger: 'adding the `propr` label',
});

/** Ticket ids that land in one shard of `keyOf`. */
function sameShard(keyOf: (id: string) => string, count: number): string[] {
  const groups = new Map<string, string[]>();
  for (let i = 0; ; i += 1) {
    const id = `ticket-${String(i).padStart(4, '0')}`;
    const group = [...(groups.get(keyOf(id)) ?? []), id];
    if (group.length === count) return group;
    groups.set(keyOf(id), group);
  }
}

/** A kit whose createIssue answers after a tick, so concurrent hand-offs interleave at every awaited step. */
function slowKit() {
  let issues = 0;
  const k = createTestPluginContext({
    pluginId: 'linear',
    propr: { createIssue: async repository => { await new Promise(r => setTimeout(r, 5)); issues += 1; return { repository, number: issues, url: `https://github.com/${repository}/issues/${issues}` }; } },
  });
  return { ...k, created: () => k.calls.filter(c => c.operation === 'createIssue') };
}

test('tickets sharing a shard handed off at the same time keep every record', async () => {
  const ids = sameShard(ticketKey, 6);
  const k = slowKit();
  const results = await Promise.all(ids.map(id => handOffTicket(k.ctx, handOff(id))));
  assert.deepEqual(results.map(r => r.outcome), ids.map(() => 'created'));
  assert.equal(k.created().length, ids.length);
  const numbers = new Set<number>();
  for (const id of ids) {
    const record = await readTicket(k.ctx, id);
    assert.equal(record?.s, 'created', `${id} is remembered`);
    numbers.add(record!.n!);
  }
  assert.equal(numbers.size, ids.length, 'each ticket keeps its own issue');
  // Re-adding the label to any of them creates nothing more.
  for (const id of ids) assert.equal((await handOffTicket(k.ctx, handOff(id))).outcome, 'duplicate');
  assert.equal(k.created().length, ids.length);
});

test('deliveries for one ticket at the same time create one issue', async () => {
  const k = slowKit();
  const results = await Promise.all(Array.from({ length: 5 }, () => handOffTicket(k.ctx, handOff('ticket-same'))));
  assert.equal(k.created().length, 1);
  assert.deepEqual(results.map(r => r.outcome).sort(), ['created', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
  assert.equal((await readTicket(k.ctx, 'ticket-same'))?.s, 'created');
});

test('progress of tickets sharing a shard, written at the same time, is all kept', async () => {
  const ids = sameShard(progressKey, 5);
  const k = createTestPluginContext({ pluginId: 'linear' });
  // Each change yields first, as an event handler does between its reads and writes.
  const mark = async (id: string, marker: string) => { await new Promise(r => setTimeout(r, 1)); await updateProgress(k.ctx, id, p => (p.d.includes(marker) ? undefined : { ...p, d: [...p.d, marker] })); };
  await Promise.all(ids.flatMap(id => [mark(id, 'opened:1:comment'), mark(id, 'opened:1:move'), updateProgress(k.ctx, id, p => ({ ...p, p: [7] }))]));
  for (const id of ids) {
    const progress = await readProgress(k.ctx, id);
    assert.deepEqual([...progress.d].sort(), ['opened:1:comment', 'opened:1:move'], id);
    assert.deepEqual(progress.p, [7], id);
  }
});

test('a shard filled by hand-offs under way at once still records every issue created', async () => {
  // Far more tickets sharing a shard than it holds, all reserved before any GitHub request answers.
  const ids = sameShard(ticketKey, 260);
  let issues = 900_000;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const k = createTestPluginContext({
    pluginId: 'linear',
    propr: { createIssue: async repository => { await gate; issues += 1; return { repository, number: issues, url: `https://github.com/${repository}/issues/${issues}` }; } },
  });
  const created = () => k.calls.filter(c => c.operation === 'createIssue').length;
  const running = Promise.allSettled(ids.map(id => handOffTicket(k.ctx, handOff(id))));
  await new Promise(r => setTimeout(r, 10));
  release();
  const results = await running;
  const refused = results.flatMap((r, i) => (r.status === 'rejected' ? [ids[i]] : []));
  assert.ok(refused.length > 0, 'the shard filled');
  for (const result of results) {
    if (result.status === 'rejected') assert.ok(result.reason instanceof PluginDeliveryError && !result.reason.permanent && /retried later/.test(result.reason.message), String(result.reason));
  }
  // Every issue created was recorded with its number; a refused hand-off created nothing.
  assert.equal(results.filter(r => r.status === 'fulfilled').length, created());
  const shard = k.state.get(ticketKey(ids[0])) as unknown as TicketRecord[];
  assert.ok(Buffer.byteLength(JSON.stringify(shard)) <= SHARD_BYTES);
  assert.equal(shard.filter(r => r.s === 'pending').length, 0, 'no created issue is left pending');
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') assert.equal((await readTicket(k.ctx, ids[i]))?.n, result.value.issue, ids[i]);
  }
  // A refused hand-off retried later is created (the oldest finished records make room).
  assert.equal((await handOffTicket(k.ctx, handOff(refused[0]))).outcome, 'created');
});

test('a ticket keeps every linked pull request, forgetting finished ones first past the limit', async () => {
  const progress = (p: number[], d: string[] = []): ProgressRecord => ({ t: 'ticket-x', p, d, at: 0 });
  assert.deepEqual(withPullRequest(progress([55]), 56), [55, 56]);
  assert.equal(withPullRequest(progress([55, 56]), 55), undefined, 'already linked');
  const full = Array.from({ length: PULL_LIMIT }, (_, i) => i + 1);
  assert.deepEqual(withPullRequest(progress(full, ['closed:3:comment']), 99), [...full.filter(n => n !== 3), 99], 'a finished one goes first');
  assert.deepEqual(withPullRequest(progress(full), 99), [...full.slice(1), 99], 'then the oldest');

  // Through the shard: both pull requests find the ticket.
  const k = createTestPluginContext({ pluginId: 'linear', propr: { createIssue: repository => ({ repository, number: 101, url: '' }) } });
  await handOffTicket(k.ctx, handOff('ticket-pr'));
  await updateProgress(k.ctx, 'ticket-pr', p => ({ ...p, p: withPullRequest(p, 55) }));
  await updateProgress(k.ctx, 'ticket-pr', p => ({ ...p, p: withPullRequest(p, 56) }));
  for (const pr of [55, 56]) assert.equal((await findTicketByPullRequest(k.ctx, 'acme/api', pr))?.t, 'ticket-pr', `#${pr}`);
});

test('a linked pull request\'s merge and close markers outlive the rolling history and go with the pull request', async () => {
  const k = createTestPluginContext({ pluginId: 'linear' });
  const mark = (marker: string) => updateProgress(k.ctx, 'ticket-f', p => ({ ...p, d: [...p.d, marker] }));
  await updateProgress(k.ctx, 'ticket-f', p => ({ ...p, p: [55] }));
  for (const marker of ['opened:55:move', 'merged:55:comment', 'merged:55:move']) await mark(marker);
  // Later pull requests fill the history; linking one rebuilds the record without `f`.
  for (let pr = 56; pr < 56 + PULL_LIMIT - 1; pr += 1) {
    await updateProgress(k.ctx, 'ticket-f', p => ({ t: p.t, p: withPullRequest(p, pr), d: p.d }));
    for (const step of ['opened', 'merged']) for (const kind of ['comment', 'move']) await mark(`${step}:${pr}:${kind}`);
  }
  let progress = await readProgress(k.ctx, 'ticket-f');
  assert.equal(progress.d.some(m => m.includes(':55:')), false, 'gone from the history');
  assert.deepEqual(doneMarkers(progress).filter(m => m.includes(':55:')).sort(), ['merged:55:comment', 'merged:55:move']);
  // #55, finished, is the one forgotten when one more pull request is linked; its markers go with it.
  await updateProgress(k.ctx, 'ticket-f', p => ({ ...p, p: withPullRequest(p, 99) }));
  progress = await readProgress(k.ctx, 'ticket-f');
  assert.equal(linkedPulls(progress).includes(55), false);
  assert.equal(doneMarkers(progress).some(m => m.includes(':55:')), false);
});

test('a full progress shard keeps a ticket with a pull request still open over one whose pull requests all finished', async () => {
  const [open, done, ...rest] = sameShard(progressKey, 400);
  // The oldest ticket's first pull request closed but its second is open; the next one's only pull request merged.
  const seeded: ProgressRecord[] = [
    { t: open, p: [55, 56], d: ['closed:55:comment'], at: 1 },
    { t: done, p: [57], d: ['merged:57:comment'], at: 2 },
  ];
  const filler = 'x'.repeat(40);
  for (const [i, id] of rest.entries()) {
    const list = [...seeded, { t: id, d: [filler], at: 3 + i }];
    if (Buffer.byteLength(JSON.stringify(list)) > SHARD_BYTES - 60) break;
    seeded.push(list[list.length - 1]);
  }
  assert.ok(seeded.length < rest.length + 2, 'the shard is full');
  const k = createTestPluginContext({ pluginId: 'linear', state: { [progressKey(open)]: seeded as unknown as PluginJsonValue } });
  await updateProgress(k.ctx, rest[rest.length - 1], p => ({ ...p, d: [filler, filler] }));
  const kept = (k.state.get(progressKey(open)) as unknown as ProgressRecord[]).map(r => r.t);
  assert.ok(kept.includes(open), 'the ticket whose pull request #56 is open is kept');
  assert.equal(kept.includes(done), false, 'the finished ticket is forgotten first');
});

const KEY_ENTITY = /&(?:amp|lt|gt);/g;
/** Whether every `&` in the text starts a whole entity: no cut left half of one. */
const wholeEntities = (text: string) => !text.replace(KEY_ENTITY, '').includes('&');

test('a description that grows when escaped still fits the issue body, cut on whole entities', async () => {
  const ampersands = '&'.repeat(14_000);
  const body = ticketIssueBody(handOff('ticket-amp', ampersands));
  assert.ok(Buffer.byteLength(body) <= ISSUE_BODY_BYTES, `${Buffer.byteLength(body)} bytes`);
  assert.ok(body.length <= PLUGIN_PROPR_LIMITS.bodyChars);
  assert.ok(wholeEntities(body), 'no entity is split');
  assert.ok(body.includes('&amp;…'), 'the cut is shown');
  assert.ok(body.endsWith('does not cancel the work._'), 'the wrapper is kept whole');

  // Through handOffTicket, against createIssue's real limit (plus the attribution marker ProPR appends).
  const sent: string[] = [];
  const strict = createTestPluginContext({
    pluginId: 'linear',
    propr: { createIssue: (repository, issue) => {
      const withMarker = `${issue.body ?? ''}\n\n<!-- propr-plugin:linear -->`;
      if ((issue.body ?? '').length > PLUGIN_PROPR_LIMITS.bodyChars || Buffer.byteLength(withMarker) > PLUGIN_PROPR_LIMITS.bodyChars) throw new Error('body too long');
      sent.push(issue.body ?? '');
      return { repository, number: 1, url: '' };
    } },
  });
  for (const [id, description] of [['ticket-1', ampersands], ['ticket-2', '<'.repeat(19_999)], ['ticket-3', '&<>'.repeat(6_000)]] as const) {
    assert.equal((await handOffTicket(strict.ctx, handOff(id, description))).outcome, 'created', id);
  }
  assert.equal(sent.length, 3);
});

test('a multibyte description is cut on whole characters within the byte budget', () => {
  for (const unit of ['東', '😀', 'é', '😀&@x ']) {
    const quote = inertQuote(unit.repeat(20_000), 30_000);
    assert.ok(Buffer.byteLength(quote) <= 30_000, unit);
    assert.ok(quote.endsWith('…'), unit);
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(quote), false, `${unit}: no lone surrogate`);
    assert.ok(wholeEntities(quote), unit);
    assert.equal(/@(?!⁠)[A-Za-z0-9]/.test(quote), false, `${unit}: every mention stays broken`);
    const body = ticketIssueBody(handOff('ticket-mb', unit.repeat(20_000)));
    assert.ok(Buffer.byteLength(body) <= ISSUE_BODY_BYTES, `${unit}: ${Buffer.byteLength(body)} bytes`);
  }
  // A cut never separates a mention from its word joiner.
  const mentions = inertQuote('@a '.repeat(1_000), 101);
  assert.equal(/@(?!⁠)/.test(mentions), false);
  // A short description is unchanged.
  assert.equal(inertQuote('a & b'), '> a &amp; b');
});
