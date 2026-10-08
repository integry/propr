import assert from 'node:assert/strict';
import { test } from 'node:test';
import knex from 'knex';
import { randomUUID } from 'node:crypto';
import { USAGE_TIPS_CATALOG, USAGE_TIPS_DAY_MS as DAY, isUsageTipEligible,
  resolveUsageTips, rotateUsageTipCandidates } from '@propr/shared';
import { createUsageTipsStore } from '../src/services/usageTips/store.js';
import { selectUsageTips, heuristicUsageTipCandidates } from '../src/services/usageTips/selection.js';
import { collectUsageTipSignals, usageSignalTimestamp } from '../src/services/usageTips/signals.js';
import { up, down } from '../src/db/migrations/20260928000000_add_usage_tips.js';
import { up as removeCooldownSetting } from '../src/db/migrations/20261008000000_remove_usage_tips_cooldown_setting.js';

const candidates = USAGE_TIPS_CATALOG.slice(0, 6).map(t => ({ id: t.id, score: 85, reason: 'Recorded usage gap.' }));
const selection = { candidates, signals: {}, model: null, source: 'heuristic' as const, generatedAt: 100, rotationEpoch: 0 };
async function fixture(run: (database: ReturnType<typeof knex>) => Promise<void>) {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await database.schema.createTable('system_configs', t => { t.string('key').primary(); t.text('value'); });
    await up(database);
    await run(database);
  } finally { await database.destroy(); }
}

test('fixed cooldown regardless of repeat dismissals, exact boundary, no dismissal eligibility', () => {
  assert.equal(isUsageTipEligible(undefined, 1000), true);
  for (const dismissal_count of [1, 2, 9999]) {
    const dismissal = { tip_id: candidates[0].id, dismissed_at: 1000, dismissal_count };
    assert.equal(isUsageTipEligible(dismissal, 1000 + 45 * DAY - 1), false);
    assert.equal(isUsageTipEligible(dismissal, 1000 + 45 * DAY), true);
  }
  assert.equal(isUsageTipEligible({ tip_id: candidates[0].id, dismissed_at: -1, dismissal_count: 1 }, 1000 + 45 * DAY), false);
});

test('eligibility and unknown-ID filtering happen before cap; sole candidates recur forever', () => {
  const dismissals = candidates.slice(0, 3).map(c => ({ tip_id: c.id, dismissed_at: 0, dismissal_count: 1 }));
  const pool = [{ id: 'removed', score: 100, reason: 'old' }, ...candidates];
  assert.deepEqual(resolveUsageTips(pool, dismissals, 1).map(t => t.id), candidates.slice(3).map(c => c.id));
  assert.deepEqual(resolveUsageTips(pool, dismissals, 45 * DAY).map(t => t.id), candidates.slice(0, 3).map(c => c.id));
  for (let epoch = 0; epoch < 10; epoch++) assert.equal(resolveUsageTips(rotateUsageTipCandidates([candidates[0]], epoch), [], epoch * DAY).length, 1);
});

test('rotation preserves ten-point bands and varies the first three within a band', () => {
  const pool = [...candidates, { id: 'goals-launch', score: 100, reason: 'Highly relevant' }, { id: 'agent-tank', score: 80, reason: 'Lower band' }];
  const first = rotateUsageTipCandidates(pool, 0);
  assert.deepEqual(first, rotateUsageTipCandidates(pool.reverse(), 0));
  assert.equal(first[0].id, 'goals-launch');
  assert.equal(first.at(-1)?.id, 'agent-tank');
  assert.notDeepEqual(first.slice(1, 4), rotateUsageTipCandidates(pool, 1).slice(1, 4));
});

test('atomic durable deduplication, concurrency, isolation, expiry and read-only reads', async () => fixture(async db => {
  let now = 1000;
  let store = createUsageTipsStore(db, () => now);
  assert.equal(await store.persist(selection, null), true);
  assert.equal(await store.persist(selection, null), false);
  const event = randomUUID();
  await Promise.all([store.dismiss('alice', candidates[0].id, event), store.dismiss('alice', candidates[0].id, event)]);
  now += DAY;
  store = createUsageTipsStore(db, () => now); // simulates restarting the service
  await store.dismiss('alice', candidates[0].id, event);
  let dismissal = await db('usage_tip_dismissals').first();
  assert.equal(dismissal.dismissal_count, 1);
  assert.equal(dismissal.dismissed_at, 1000);
  await assert.rejects(store.dismiss('alice', candidates[1].id, event));
  assert.equal((await store.get('alice')).tips.some(t => t.id === candidates[0].id), false);
  assert.equal((await store.get('bob')).tips[0].id, candidates[0].id);
  now = 1000 + 45 * DAY;
  assert.equal((await store.get('alice')).tips[0].id, candidates[0].id);
  await Promise.all([store.dismiss('alice', candidates[0].id, randomUUID()), store.dismiss('alice', candidates[0].id, randomUUID())]);
  dismissal = await db('usage_tip_dismissals').first();
  assert.equal(dismissal.dismissal_count, 3);
  assert.equal(dismissal.dismissed_at, now);
  now += 720 * DAY;
  assert.equal((await store.get('alice')).tips[0].id, candidates[0].id);
  const queries: string[] = [];
  db.on('query', q => queries.push(q.sql));
  await store.get('alice');
  await store.get('bob');
  assert.ok(queries.every(q => /^select /i.test(q)), queries.join('\n'));
  assert.ok(queries.every(q => !/count\(|join |llm_logs|task_history/i.test(q)));
  assert.equal((await db('usage_tip_dismissals').first()).dismissal_count, 3);
  await db('system_configs').where({ key: 'usage_tips_enabled' }).update({ value: 'false' });
  assert.deepEqual(await store.get('alice'), { enabled: false, tips: [] });
}));

test('migration seeds defaults, rollback owns only its keys, and constraints protect storage', async () => fixture(async db => {
  await db('system_configs').insert({ key: 'unrelated', value: '7' });
  assert.deepEqual(await createUsageTipsStore(db).settings(), { enabled: true });
  await assert.rejects(db('usage_tip_selection').insert({ id: 2, candidates: '[]', signals: '{}', source: 'heuristic', generated_at: 0, rotation_epoch: 0 }));
  await removeCooldownSetting(db);
  assert.equal(await db('system_configs').where({ key: 'usage_tips_dismissal_cooldown_days' }).first(), undefined);
  assert.ok(await db('system_configs').where({ key: 'usage_tips_enabled' }).first());
  await down(db);
  assert.deepEqual(await db('system_configs'), [{ key: 'unrelated', value: '7' }]);
}));

test('event insertion rolls back if dismissal update fails', async () => fixture(async db => {
  await db.raw("CREATE TRIGGER fail_dismissal BEFORE INSERT ON usage_tip_dismissals BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const store = createUsageTipsStore(db);
  const event = randomUUID();
  await assert.rejects(store.dismiss('alice', candidates[0].id, event));
  assert.equal((await db('usage_tip_dismissal_events')).length, 0);
  await db.raw('DROP TRIGGER fail_dismissal');
  await store.dismiss('alice', candidates[0].id, event);
  assert.equal((await db('usage_tip_dismissals').first()).dismissal_count, 1);
}));

test('model validation, fallback, deterministic heuristics, valid empty and exclusions', async () => {
  const signals = { tasks: 12, manualCycles: 4, ultrafix: 0, oneOffTasks: 8, goals: 0, plans: 0, indexingFailures: 2, review: 8 };
  const aliases: string[] = [];
  const options = { signals, epoch: 3, agentAlias: 'primary', fallbackAgentAlias: 'fallback', now: () => 99 };
  const result = await selectUsageTips({ ...options, generate: async alias => {
    aliases.push(alias);
    if (alias === 'primary') return { text: '{"candidates":[{"id":"pr-ultrafix","score":101,"reason":"bad"}]}', model: alias };
    return { text: JSON.stringify({ candidates: [
      { id: 'unknown', score: 1, reason: 'unknown' },
      { id: 'pr-review', score: 100, reason: 'Must be excluded: used regularly' },
      { id: 'pr-ultrafix', score: 90, reason: 'Repeated manual cycles' },
      { id: 'pr-ultrafix', score: 91, reason: 'duplicate' },
    ] }), model: alias };
  } });
  assert.deepEqual(aliases, ['primary', 'fallback']);
  assert.equal(result.source, 'model');
  assert.deepEqual(result.candidates.map(c => c.id), ['pr-ultrafix']);
  const empty = await selectUsageTips({ ...options, generate: async () => ({ text: '{"candidates":[]}', model: 'primary' }) });
  assert.equal(empty.source, 'model'); assert.deepEqual(empty.candidates, []);
  const heuristic = await selectUsageTips({ ...options, generate: async () => { throw new Error('offline'); } });
  assert.equal(heuristic.source, 'heuristic');
  assert.deepEqual(heuristic.candidates, rotateUsageTipCandidates(heuristicUsageTipCandidates(signals), 3));
  for (const key of ['pr-ultrafix', 'goals-launch', 'planner-studio', 'indexing-options']) assert.ok(heuristic.candidates.some(c => c.id === key));
  assert.deepEqual(heuristicUsageTipCandidates({}), []);
  assert.deepEqual(heuristicUsageTipCandidates({ tasks: 50, goals: 5, plans: 5, oneOffTasks: 20, review: 10, fix: 10, ultrafix: 5, manualCycles: 10 }), []);
});

test('personalized model advice survives persistence and replaces catalog copy without changing identity', async () => fixture(async db => {
  const reason = 'Automate repeated manual review and fix runs with /ultrafix to reduce the commands you need to send. Recent activity shows little /ultrafix use.';
  const selected = await selectUsageTips({
    signals: { manualCycles: 4, ultrafix: 0 }, epoch: 0,
    generate: async (_alias, prompt) => {
      assert.match(prompt, /reason is the user-facing tip body/);
      assert.match(prompt, /why this tip is being displayed/);
      assert.match(prompt, /how it could improve their workflow/);
      assert.match(prompt, /installation-wide aggregates/);
      assert.match(prompt, /"manualCycles":4/);
      return { text: JSON.stringify({ candidates: [{ id: 'pr-ultrafix', score: 95, reason }] }), model: 'test-model' };
    },
  });
  const store = createUsageTipsStore(db);
  await store.persist(selected, null);
  const catalogTip = USAGE_TIPS_CATALOG.find(t => t.id === 'pr-ultrafix')!;
  assert.deepEqual((await store.get('alice')).tips, [{ ...catalogTip, body: reason }]);
  assert.notEqual(catalogTip.body, reason);
  await store.dismiss('alice', catalogTip.id, randomUUID());
  assert.deepEqual((await store.get('alice')).tips, []);
}));

test('offline advice explains the observed workflow and benefit, including slow-only indexing', async () => {
  const selected = await selectUsageTips({ signals: { indexingSlow: 2, indexingFailures: null }, epoch: 0,
    generate: async () => { throw new Error('offline'); } });
  const [tip] = resolveUsageTips(selected.candidates, [], Date.now());
  assert.match(tip.body, /Indexing calls are taking at least two minutes/);
  assert.match(tip.body, /keep repository context available for your tasks/);
  assert.doesNotMatch(tip.body, /failures/);
  assert.equal(selected.source, 'heuristic');
});

test('guarded bounded signals handle real SQLite tables and mixed timestamps', async () => fixture(async db => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const missing = await collectUsageTipSignals(db, now);
  assert.equal(missing.tasks, null); assert.equal(missing.inboxActions, null);
  await db.schema.createTable('tasks', t => { t.string('task_type'); t.text('initial_job_data'); t.timestamp('created_at'); });
  await db('tasks').insert(['review', 'fix', 'review', 'fix', 'ultrafix'].map((commandMode, index) => ({
    task_type: 'pr-comment', initial_job_data: JSON.stringify({ commandMode }), created_at: index % 2 ? now : '2026-09-27 12:00:00',
  })));
  const result = await collectUsageTipSignals(db, now);
  assert.equal(result.tasks, 5); assert.equal(result.manualCycles, 2); assert.equal(result.ultrafix, 1);
  assert.equal(result.plans, null); assert.equal(result.distinctAgents, null);
  await db('tasks').insert({ task_type: 'pr-comment', initial_job_data: '{}', created_at: now });
  assert.equal((await collectUsageTipSignals(db, now)).ultrafix, null);
  await db('tasks').insert({ task_type: 'issue', initial_job_data: '{}', created_at: 'unknown' });
  assert.equal((await collectUsageTipSignals(db, now)).tasks, null);
  assert.equal(usageSignalTimestamp('2026-09-27 12:00:00'), now);
  assert.equal(usageSignalTimestamp(String(now)), now);
}));

test('separate SQLite connections serialize distinct events and deduplication survives reopening', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { installSqliteRetry } = await import('../src/db/sqliteRetry.js');
  const directory = await mkdtemp(join(tmpdir(), 'usage-tips-'));
  const clients: ReturnType<typeof knex>[] = [];
  // The budget is generous on purpose: this test covers serialization and deduplication, not the retry
  // budget (sqliteRetry.test.ts does), and on a loaded CI host one commit can hold the lock for over a second.
  const open = () => {
    const client = installSqliteRetry(knex({ client: 'better-sqlite3', connection: { filename: join(directory, 'test.sqlite') }, useNullAsDefault: true }), { maxAttempts: 50, maxTotalMs: 30_000 });
    clients.push(client); return client;
  };
  try {
    const a = open();
    await a.schema.createTable('system_configs', t => { t.string('key').primary(); t.text('value'); });
    await up(a);
    const b = open();
    await a.raw('PRAGMA busy_timeout = 1');
    await b.raw('PRAGMA busy_timeout = 1');
    const stores = [createUsageTipsStore(a, () => 123), createUsageTipsStore(b, () => 123)];
    const events = Array.from({ length: 6 }, () => randomUUID());
    await Promise.all(events.flatMap((id, i) => [stores[i % 2].dismiss('alice', candidates[0].id, id), stores[(i + 1) % 2].dismiss('alice', candidates[0].id, id)]));
    const before = await a('usage_tip_dismissals').first();
    assert.equal(before.dismissal_count, 6);
    await Promise.all(clients.splice(0).map(c => c.destroy()));
    const reopened = open();
    await createUsageTipsStore(reopened, () => 999).dismiss('alice', candidates[0].id, events[0]);
    assert.deepEqual(await reopened('usage_tip_dismissals').first(), before);
  } finally {
    await Promise.all(clients.map(c => c.destroy()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid persisted selections fail closed without writes; invalid results cannot persist', async () => fixture(async db => {
  const store = createUsageTipsStore(db);
  await assert.rejects(store.persist({ ...selection, generatedAt: NaN }, null));
  await store.persist(selection, null);
  await db('usage_tip_selection').update({ candidates: '[{"id":"pr-review","score":999,"reason":"corrupt"}]' });
  assert.equal(await store.current(), null);
  assert.deepEqual(await store.get('alice'), { enabled: true, tips: [] });
  assert.equal((await db('usage_tip_dismissal_events')).length, 0);
}));

const discoveryIds = ['mcp-chat-control', 'visual-previews', 'repository-chat', 'epic-auto-merge'];
const unusedDiscovery = { tasks: 3, plans: 2, mcpUsage: 0, visualPreviewRepos: 0, repoChatMessages: 0, epicPlans: 0 };
const discoveryPool = discoveryIds.map((id, i) => ({ id, score: 78 - i, reason: 'Recorded activity with an unused capability.' }));

test('catalog kinds preserve corrective identities and order, and discovery has documentation', async () => {
  const { isUsageTipKind, usageTipKind, parseUsageTipCandidates } = await import('@propr/shared');
  const { access } = await import('node:fs/promises');
  assert.deepEqual(USAGE_TIPS_CATALOG.filter(t => t.kind === 'corrective').map(t => t.id), [
    'pr-review', 'pr-fix', 'pr-switch', 'pr-use', 'pr-ultrafix', 'pr-merge', 'goals-launch',
    'planner-studio', 'repository-todos', 'indexing-options', 'agent-model-selection', 'agent-tank', 'notification-inbox', 'mcp-access',
  ]);
  assert.deepEqual(USAGE_TIPS_CATALOG.filter(t => t.kind === 'discovery').map(t => t.id), discoveryIds);
  assert.ok(USAGE_TIPS_CATALOG.every(t => isUsageTipKind(t.kind)));
  assert.equal(isUsageTipKind('invented'), false);
  assert.equal(usageTipKind('removed'), undefined);
  assert.ok(USAGE_TIPS_CATALOG.slice(0, -4).every(t => t.kind === 'corrective'));
  for (const tip of USAGE_TIPS_CATALOG.slice(-4)) {
    await access(new URL(`../../../${tip.docPath}`, import.meta.url));
    assert.ok(tip.body.length <= 240);
  }
  assert.deepEqual(parseUsageTipCandidates([{ ...discoveryPool[0], kind: 'corrective' }]), [discoveryPool[0]]);
});

test('discovery requires exact zero usage and known prerequisite activity', async () => {
  const { DISCOVERY_RULES, discoveryUsageTipCandidates, isDiscoveryTipApplicable } = await import('../src/services/usageTips/selection.js');
  assert.deepEqual(discoveryUsageTipCandidates(unusedDiscovery).map(c => c.id), discoveryIds);
  for (const rule of DISCOVERY_RULES) {
    for (const usage of [null, undefined, 1, 3, -1, false, NaN]) {
      const signals = { ...unusedDiscovery, [rule.usage]: usage };
      if (usage === undefined) delete signals[rule.usage];
      assert.equal(isDiscoveryTipApplicable(rule.id, signals), false);
      assert.ok(!heuristicUsageTipCandidates(signals).some(c => c.id === rule.id));
    }
    for (const activity of [null, 0, rule.minimum - 1]) {
      assert.equal(isDiscoveryTipApplicable(rule.id, { ...unusedDiscovery, [rule.prerequisite]: activity }), false);
    }
  }
  assert.deepEqual(discoveryUsageTipCandidates({ mcpUsage: 0, visualPreviewRepos: 0, repoChatMessages: 0, epicPlans: 0 }), []);
  assert.deepEqual(heuristicUsageTipCandidates({ tasks: 50, plans: 5, mcpUsage: 1, visualPreviewRepos: 1, repoChatMessages: 1, epicPlans: 1 }), []);
  assert.ok(discoveryUsageTipCandidates(unusedDiscovery).every(c => c.score >= 70 && c.score <= 79 && c.reason.length <= 240));
});

test('mix preserves pool order, caps both kinds, and fills all slots for a sole kind', () => {
  const corrective = candidates.slice(0, 5).map((c, i) => ({ ...c, score: 95 - i * 2 }));
  for (const pool of [[...corrective, ...discoveryPool.slice(0, 2)], [...discoveryPool, ...corrective]]) {
    const shown = resolveUsageTips(pool, [], 1);
    assert.equal(shown.length, 3);
    assert.ok(shown.filter(t => t.kind === 'discovery').length >= 1);
    assert.ok(shown.filter(t => t.kind === 'corrective').length >= 1);
    assert.deepEqual(shown.map(t => t.id), pool.filter(c => shown.some(t => t.id === c.id)).map(c => c.id));
  }
  assert.equal(resolveUsageTips(discoveryPool, [], 1).length, 3);
  assert.equal(resolveUsageTips(corrective, [], 1).length, 3);
  for (const [primary, secondary] of [[corrective, discoveryPool], [discoveryPool, corrective]]) {
    const pool = [...primary, ...secondary];
    const dismissals = secondary.slice(0, 1).map(c => ({ tip_id: c.id, dismissed_at: 0, dismissal_count: 1 }));
    assert.deepEqual(resolveUsageTips(pool, dismissals, 1).map(t => t.id), [primary[0].id, primary[1].id, secondary[1].id]);
    const allSecondary = secondary.map(c => ({ tip_id: c.id, dismissed_at: 0, dismissal_count: 1 }));
    assert.deepEqual(resolveUsageTips(pool, allSecondary, 1).map(t => t.id), primary.slice(0, 3).map(c => c.id));
  }
});

for (const [kind, primaryIds, secondaryIds, scores] of [
  ['corrective', ['pr-ultrafix', 'planner-studio', 'pr-switch'], ['mcp-chat-control', 'repository-chat', 'visual-previews'], [95, 85, 78, 76, 74, 55]],
  ['discovery', ['epic-auto-merge', 'mcp-chat-control', 'visual-previews'], ['pr-fix', 'pr-review', 'pr-switch'], [79, 78, 77, 76, 75, 70]],
] as const) {
  const ids = [primaryIds[0], primaryIds[1], ...secondaryIds, primaryIds[2]];
  const pool = rotateUsageTipCandidates(ids.map((id, i) => ({ id, score: scores[i], reason: 'Relevant recorded activity.' })), 0);
  const initialIds = [primaryIds[0], primaryIds[1], secondaryIds[0]];

  test(`interleaved ${kind}-majority pool replaces either kind without changing its allocation`, () => {
    assert.deepEqual(pool.map(c => c.id), ids);
    assert.deepEqual(resolveUsageTips(pool, [], 1).map(t => t.id), initialIds);
    for (const dismissedId of initialIds) {
      const replacement = dismissedId === secondaryIds[0] ? secondaryIds[1] : primaryIds[2];
      const expected = new Set([...initialIds.filter(id => id !== dismissedId), replacement]);
      const dismissals = [{ tip_id: dismissedId, dismissed_at: 0, dismissal_count: 1 }];
      assert.deepEqual(resolveUsageTips(pool, dismissals, 1).map(t => t.id), ids.filter(id => expected.has(id)));
    }
  });

  test(`persisted ${kind} slots survive reloads and transfer only on exhaustion`, async () => fixture(async db => {
    let now = 1000;
    let store = createUsageTipsStore(db, () => now);
    await store.persist({ ...selection, candidates: pool }, null);
    const shown = async () => (await store.get('alice')).tips.map(t => t.id);
    assert.deepEqual(await shown(), initialIds);
    const event = randomUUID();
    await store.dismiss('alice', primaryIds[1], event);
    store = createUsageTipsStore(db, () => now);
    await store.dismiss('alice', primaryIds[1], event);
    assert.deepEqual(await shown(), [primaryIds[0], secondaryIds[0], primaryIds[2]]);
    assert.deepEqual((await store.get('bob')).tips.map(t => t.id), initialIds);
    await store.dismiss('alice', primaryIds[2], randomUUID());
    assert.deepEqual(await shown(), [primaryIds[0], secondaryIds[0], secondaryIds[1]]);
    await store.dismiss('alice', secondaryIds[0], randomUUID());
    assert.deepEqual(await shown(), [primaryIds[0], secondaryIds[1], secondaryIds[2]]);
    await store.dismiss('alice', primaryIds[0], randomUUID());
    assert.deepEqual(await shown(), [secondaryIds[1], secondaryIds[2]]);
    now += 45 * DAY;
    assert.deepEqual(await shown(), initialIds);
    assert.deepEqual((await store.current())?.candidates, pool);
  }));
}

test('rotation never lets discovery scores displace urgent corrective scores, including 80', () => {
  const urgent = candidates.slice(0, 3).map((c, i) => ({ ...c, score: 80 + i * 5 }));
  for (let epoch = 0; epoch < 10; epoch++) {
    const rotated = rotateUsageTipCandidates([...discoveryPool, ...urgent], epoch);
    assert.deepEqual(new Set(rotated.slice(0, 3).map(c => c.id)), new Set(urgent.map(c => c.id)));
    const resolved = resolveUsageTips(rotated, [], 1);
    assert.deepEqual(resolved.slice(0, 2).map(t => t.kind), ['corrective', 'corrective']);
    assert.equal(resolved[2].kind, 'discovery');
  }
});

test('model discovery is post-filtered, band-limited and supplemented without overriding empty answers', async () => {
  const run = (signals: Record<string, number | boolean | null>, output: unknown[]) => selectUsageTips({ signals, epoch: 0,
    generate: async (_alias, prompt) => {
      assert.match(prompt, /usage signal is exactly 0/);
      assert.match(prompt, /"kind":"discovery"/);
      return { text: JSON.stringify({ candidates: output }), model: 'test' };
    } });
  const corrective = { id: 'indexing-options', score: 95, reason: 'Indexing failures are recorded.' };
  const signals = { ...unusedDiscovery, indexingFailures: 2 };
  const supplemented = await run(signals, [corrective]);
  assert.equal(supplemented.source, 'model');
  assert.deepEqual(supplemented.candidates.map(c => c.id), [corrective.id, ...discoveryIds.slice(0, 2)]);
  assert.deepEqual((await run(signals, [])).candidates, []);
  const filtered = await run({ ...signals, mcpUsage: null }, [discoveryPool[0], discoveryPool[1]]);
  assert.deepEqual(filtered.candidates.map(c => c.id), ['visual-previews']);
  assert.deepEqual((await run({ ...signals, mcpUsage: 1 }, [discoveryPool[0]])).candidates, []);
  assert.deepEqual((await run({ ...signals, tasks: 0 }, [discoveryPool[0], discoveryPool[3]])).candidates, [discoveryPool[3]]);
  for (const score of [1, 100]) {
    const result = await run(signals, [{ ...discoveryPool[0], score, kind: 'corrective' }, corrective]);
    assert.equal(result.candidates[0].id, corrective.id);
    assert.ok(result.candidates[1].score >= 70 && result.candidates[1].score <= 79);
    assert.equal('kind' in result.candidates[1], false);
  }
});

test('persisted candidates omit kind; mixed dismissals remain per-user and preserve replacements', async () => fixture(async db => {
  const store = createUsageTipsStore(db, () => 100);
  await store.persist({ ...selection, candidates: [...candidates, ...discoveryPool] }, null);
  const stored = JSON.parse((await db('usage_tip_selection').first()).candidates);
  assert.ok(stored.every((c: object) => !('kind' in c)));
  const before = (await store.get('alice')).tips;
  assert.equal(before[2].kind, 'discovery');
  await store.dismiss('alice', before[2].id, randomUUID());
  const after = (await store.get('alice')).tips;
  assert.equal(after[2].id, discoveryPool[1].id);
  assert.deepEqual((await store.get('bob')).tips, before);
}));

test('discovery signals use guarded adoption metadata and never infer zero from incomplete JSON samples', async () => fixture(async db => {
  const keys = ['mcpUsage', 'visualPreviewRepos', 'repoChatMessages', 'epicPlans'];
  const read = async () => {
    const signals = await collectUsageTipSignals(db);
    return keys.map(key => signals[key]);
  };
  assert.deepEqual(await read(), [null, null, null, null]);
  await db.schema.createTable('mcp_access_log', t => { t.increments('id'); t.string('kind'); });
  await db.schema.createTable('repo_chat_messages', t => { t.increments('id'); });
  await db.schema.createTable('task_drafts', t => { t.increments('id'); t.text('context_config'); t.timestamp('created_at'); });
  await db('system_configs').insert({ key: 'repos_to_monitor', value: JSON.stringify([{ name: 'example/workspace' }]) });
  await db('mcp_access_log').insert({ kind: 'auth' });
  await db('task_drafts').insert([{ context_config: '{}' }, { context_config: null }]);
  assert.deepEqual(await read(), [0, 0, 0, 0]);
  await db('mcp_access_log').insert({ kind: 'tool' });
  await db('repo_chat_messages').insert({});
  await db('task_drafts').insert({ context_config: JSON.stringify({ useEpic: true }) });
  await db('system_configs').where({ key: 'repos_to_monitor' }).update({ value: JSON.stringify([
    { name: 'example/workspace', visualPreview: { enabled: true } }, { name: 'example/workspace', visualPreview: { enabled: true } },
  ]) });
  assert.deepEqual(await read(), [1, 1, 1, 1]);
  for (const value of ['broken', 'null', '[]', '{"useEpic":"false"}']) {
    await db('task_drafts').update({ context_config: value });
    assert.equal((await collectUsageTipSignals(db)).epicPlans, null);
  }
  for (const value of ['broken', '{}', 'null', '[null]', '[{"name":"example/workspace","visualPreview":{"enabled":"false"}}]']) {
    await db('system_configs').where({ key: 'repos_to_monitor' }).update({ value });
    assert.equal((await collectUsageTipSignals(db)).visualPreviewRepos, null);
  }
  await db('task_drafts').delete();
  for (let i = 0; i < 10; i++) await db('task_drafts').insert(Array.from({ length: 100 }, () => ({ context_config: '{}' })));
  await db('system_configs').where({ key: 'repos_to_monitor' }).update({ value: JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ name: `example/repo-${i}` }))) });
  const bounded = await collectUsageTipSignals(db);
  assert.equal(bounded.epicPlans, null);
  assert.equal(bounded.visualPreviewRepos, null);
}));
