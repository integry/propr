import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLUGIN_PROPR_LIMITS } from '@propr/shared';
import { createTestPluginContext } from '../testing/index.js';
import { ISSUE_BODY_BYTES, handOffTicket, inertQuote, ticketIssueBody, type TicketHandOff } from '../_shared/trackerIssue.js';
import { progressKey, readProgress, readTicket, ticketKey, updateProgress } from '../_shared/trackerRecords.js';

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
  await Promise.all(ids.flatMap(id => [mark(id, 'opened:1:comment'), mark(id, 'opened:1:move'), updateProgress(k.ctx, id, p => ({ ...p, p: 7 }))]));
  for (const id of ids) {
    const progress = await readProgress(k.ctx, id);
    assert.deepEqual([...progress.d].sort(), ['opened:1:comment', 'opened:1:move'], id);
    assert.equal(progress.p, 7, id);
  }
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
