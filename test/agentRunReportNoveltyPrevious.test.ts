import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { MAX_AUTOMATION_PREVIOUS_REPORTS } from '@propr/shared';
import { createAgentDefinition, type StoredAgentDefinition } from '../packages/core/src/services/agents/agentDefinitionStore.ts';
import { createAgentRun, transitionAgentRun, type StoredAgentRun } from '../packages/core/src/services/agents/agentRunStore.ts';
import { listLatestStoredReports, listPreviousReports, storeAgentRunReport, storeUnclassifiedAgentRunReport } from '../packages/core/src/services/agents/agentRunReports.ts';

const { reportNoveltyPatch, storeReportWithNovelty } = await import('../src/jobs/agentRuns/reportNovelty.ts');
type ReportNoveltyStore = import('../src/jobs/agentRuns/reportNovelty.ts').ReportNoveltyStore;

/**
 * F8: report novelty compares with the previous reported run of the definition,
 * that is the report stored last, against the real store, not with the prompt
 * history (runs created earlier whose run did not fail).
 */

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const NOW = Date.UTC(2026, 10, 11, 22, 0);
const REPORT_A = 'Dependency watch: lodash is outdated in acme/web; no security advisories are open.';
const REPORT_B = 'Dependency watch: react is outdated in acme/api; two security advisories are open.';

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

let database: Knex;
let clock: number;
let definition: StoredAgentDefinition;
const deps = () => ({ database, now: () => clock });
const silent = { warn: () => undefined };

beforeEach(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.migrate.latest({ directory: migrations });
  clock = NOW;
  definition = await createAgentDefinition({ ownerId: 'alice', name: 'Nightly triage', prompt: 'Summarize', autonomyMode: 'auto' }, deps());
});
afterEach(async () => { await database.destroy(); });

async function startRun(): Promise<StoredAgentRun> {
  clock += 1_000;
  const { run } = await createAgentRun({ definition, trigger: 'schedule' }, deps());
  return (await transitionAgentRun(run.id, ['queued'], 'running', { reportTaskId: `task-${run.id}` }, deps()))!;
}

/** Classifies the report the way the processor does, then stores it as the run's report. */
async function report(run: StoredAgentRun, text: string) {
  clock += 1_000;
  const novelty = await reportNoveltyPatch(run, text, {
    listLatestReports: (definitionId, options) => listLatestStoredReports(definitionId, options, deps()),
    listPreviousReports: (definitionId, options) => listPreviousReports(definitionId, options, deps()),
  }, silent);
  assert.ok(await transitionAgentRun(run.id, ['running'], 'report_ready', { report: text, ...novelty }, deps()));
  return novelty;
}

describe('report novelty against the previous reported run (F8)', () => {
  test('a run whose acting step failed afterwards is still the previous reported run', async () => {
    const first = await startRun();
    assert.equal((await report(first, REPORT_A)).reportNovelty, 'new');
    await transitionAgentRun(first.id, ['report_ready'], 'completed', {}, deps());

    const acting = await startRun();
    assert.equal((await report(acting, REPORT_B)).reportNovelty, 'new');
    await transitionAgentRun(acting.id, ['report_ready'], 'acting', {}, deps());
    await transitionAgentRun(acting.id, ['acting'], 'failed', { failureReason: 'acting step failed' }, deps());

    const next = await startRun();
    assert.equal((await report(next, REPORT_B)).reportNovelty, 'unchanged', 'B was already the last report');
    // Repeated acting failures do not keep the same report new.
    await transitionAgentRun(next.id, ['report_ready'], 'acting', {}, deps());
    await transitionAgentRun(next.id, ['acting'], 'failed', { failureReason: 'acting step failed' }, deps());
    assert.equal((await report(await startRun(), REPORT_B)).reportNovelty, 'unchanged');
  });

  test('a run that reports after a newer run compares with that newer run\'s report', async () => {
    const first = await startRun();
    await report(first, REPORT_A);
    await transitionAgentRun(first.id, ['report_ready'], 'completed', {}, deps());

    // Created before `newer`, but it reports only after `newer` has reported B.
    const older = await startRun();
    const newer = await startRun();
    assert.equal((await report(newer, REPORT_B)).reportNovelty, 'new');
    await transitionAgentRun(newer.id, ['report_ready'], 'completed', {}, deps());
    assert.equal((await report(older, REPORT_B)).reportNovelty, 'unchanged');
  });

  test('the prompt history is left as it was: created earlier, failed runs excluded', async () => {
    const first = await startRun();
    await report(first, REPORT_A);
    const failed = await startRun();
    await report(failed, REPORT_B);
    await transitionAgentRun(failed.id, ['report_ready'], 'failed', { failureReason: 'boom' }, deps());
    const current = await startRun();
    const history = await listPreviousReports(definition.id, { limit: 5, beforeCreatedAt: current.createdAt, excludeRunId: current.id }, deps());
    assert.deepEqual(history.map(entry => entry.runId), [first.id]);
    const latest = await listLatestStoredReports(definition.id, { limit: 5, excludeRunId: current.id }, deps());
    assert.deepEqual(latest.map(entry => entry.runId), [failed.id, first.id]);
  });

  test('a report differing only in run ids from a late previous report is unchanged (F15)', async () => {
    const quoting = (runId: string) => `${REPORT_A} Compared with run ${runId}.`;
    const origin = await startRun();
    await report(origin, REPORT_B);
    // `late` starts with `origin` in its prompt history, then reports only after more
    // reports than either the latest-report window or the next run's history reaches.
    const late = await startRun();
    for (let index = 0; index <= MAX_AUTOMATION_PREVIOUS_REPORTS + 2; index += 1) {
      await report(await startRun(), `Dependency watch, round ${index}: nothing urgent in acme/web or acme/api today.`);
    }
    assert.equal((await report(late, quoting(origin.id))).reportNovelty, 'new');
    const next = await startRun();
    assert.equal((await report(next, quoting(late.id))).reportNovelty, 'unchanged', 'only the quoted run ids differ');
  });

  test('reports stored at the same moment are ordered by run id', async () => {
    const one = await startRun();
    const two = await startRun();
    clock += 1_000;
    await transitionAgentRun(one.id, ['running'], 'report_ready', { report: REPORT_A }, deps());
    await transitionAgentRun(two.id, ['running'], 'report_ready', { report: REPORT_B }, deps());
    const expected = [one.id, two.id].sort().reverse();
    assert.deepEqual((await listLatestStoredReports(definition.id, { limit: 5 }, deps())).map(entry => entry.runId), expected);
    assert.deepEqual(await listLatestStoredReports(definition.id, { limit: 0 }, deps()), []);
  });
});

/** The processor's report store against the real store, on a clock that moves with every write. */
function realStore(overrides: Partial<ReportNoveltyStore> = {}): ReportNoveltyStore {
  const ticking = () => ({ database, now: () => (clock += 1) });
  return {
    listLatestReports: (definitionId, options) => listLatestStoredReports(definitionId, options, ticking()),
    listPreviousReports: (definitionId, options) => listPreviousReports(definitionId, options, ticking()),
    storeReport: (run, input) => storeAgentRunReport(run, input, ticking()),
    storeUnclassifiedReport: (run, text) => storeUnclassifiedAgentRunReport(run, text, ticking()),
    ...overrides,
  };
}

/** Resolves for every caller once `parties` callers are waiting, then lets everyone through. */
function barrier(parties: number): () => Promise<void> {
  let waiting = 0;
  let release!: () => void;
  const all = new Promise<void>(resolve => { release = resolve; });
  return async () => {
    waiting += 1;
    if (waiting >= parties) release();
    await all;
  };
}

describe('comparing and storing a report are one step per definition (F11)', () => {
  test('of two runs storing the same report at once, only the first counts it as new', async () => {
    const first = await startRun();
    await report(first, REPORT_A);
    const one = await startRun();
    const two = await startRun();
    // Both read the latest report, A, before either stores B.
    const bothRead = barrier(2);
    const store = realStore({
      listLatestReports: async (definitionId, options) => {
        const latest = await listLatestStoredReports(definitionId, options, deps());
        await bothRead();
        return latest;
      },
    });
    const stored = await Promise.all([storeReportWithNovelty(one, REPORT_B, store, silent), storeReportWithNovelty(two, REPORT_B, store, silent)]);
    assert.deepEqual(stored.map(run => run?.state), ['report_ready', 'report_ready']);
    assert.deepEqual(stored.map(run => run?.reportNovelty).sort(), ['new', 'unchanged']);
    // The one stored second compared with the one stored first, and is the latest report now.
    const [newer] = await listLatestStoredReports(definition.id, { limit: 1 }, deps());
    assert.equal(stored.find(run => run?.id === newer.runId)?.reportNovelty, 'unchanged');
    assert.equal((await storeReportWithNovelty(await startRun(), REPORT_B, realStore(), silent))?.reportNovelty, 'unchanged');
  });

  test('a report is stored only while the report its flags were classified against is still the latest', async () => {
    const first = await startRun();
    await report(first, REPORT_A);
    const current = await startRun();
    const flags = { reportHash: 'f'.repeat(64), reportNovelty: 'new' as const };
    // Another run stored a report since `current` compared with `first`.
    await report(await startRun(), REPORT_B);
    assert.deepEqual(await storeAgentRunReport(current, { patch: { report: REPORT_B, ...flags }, previousRunId: first.id }, deps()), { outcome: 'previous_changed' });
    const untouched = await database('agent_runs').where({ id: current.id }).first('state', 'report', 'report_novelty');
    assert.deepEqual(untouched, { state: 'running', report: null, report_novelty: null }, 'nothing was stored');
    // With no predecessor expected, any stored report is a change too.
    assert.equal((await storeAgentRunReport(current, { patch: { report: REPORT_B, ...flags }, previousRunId: null }, deps())).outcome, 'previous_changed');

    const [latest] = await listLatestStoredReports(definition.id, { limit: 1, excludeRunId: current.id }, deps());
    const stored = await storeAgentRunReport(current, { patch: { report: REPORT_B, ...flags }, previousRunId: latest.runId }, deps());
    assert.equal(stored.outcome, 'stored');
    assert.equal(stored.outcome === 'stored' && stored.run.reportNovelty, 'new');

    const cancelled = await startRun();
    await transitionAgentRun(cancelled.id, ['running'], 'cancelled', {}, deps());
    assert.deepEqual(await storeAgentRunReport(cancelled, { patch: { report: REPORT_B, ...flags }, previousRunId: current.id }, deps()), { outcome: 'not_running' });
  });

  test('reports stored in the same millisecond keep their storing order, whatever their run ids (F13)', async () => {
    // A fixed clock: every write lands on the same reported_at unless the store orders them itself.
    const fixed = (): ReportNoveltyStore => ({
      listLatestReports: (definitionId, options) => listLatestStoredReports(definitionId, options, deps()),
      listPreviousReports: (definitionId, options) => listPreviousReports(definitionId, options, deps()),
      storeReport: (run, input) => storeAgentRunReport(run, input, deps()),
      storeUnclassifiedReport: (run, text) => storeUnclassifiedAgentRunReport(run, text, deps()),
    });
    const [x, y] = [await startRun(), await startRun()];
    // A's id sorts above B's, so an id tie-breaker would put A first however B was stored after it.
    const [a, b] = x.id > y.id ? [x, y] : [y, x];
    const storedA = await storeReportWithNovelty(a, REPORT_A, fixed(), silent);
    const storedB = await storeReportWithNovelty(b, REPORT_B, fixed(), silent);
    assert.deepEqual([storedA?.reportNovelty, storedB?.reportNovelty], ['new', 'new']);
    assert.ok(storedB!.reportedAt! > storedA!.reportedAt!, 'the second report is stored strictly after the first');
    assert.deepEqual((await listLatestStoredReports(definition.id, { limit: 5 }, deps())).map(entry => entry.runId), [b.id, a.id]);

    const c = await startRun();
    assert.equal((await storeReportWithNovelty(c, REPORT_B, fixed(), silent))?.reportNovelty, 'unchanged', 'C repeats the report stored last, B');
    // Classified against B, as stored; a predecessor check that picked A would refuse this.
    assert.equal((await storeAgentRunReport(await startRun(), { patch: { report: REPORT_A, reportHash: 'a'.repeat(64), reportNovelty: 'new' }, previousRunId: c.id }, deps())).outcome, 'stored');
  });

  test('a report stored without flags is still the next run\'s previous report, in storing order (F13)', async () => {
    const fixedClock = () => ({ database, now: () => clock });
    const first = await startRun();
    await report(first, REPORT_A);
    const [x, y] = [await startRun(), await startRun()];
    const [a, b] = x.id > y.id ? [x, y] : [y, x];
    clock += 1_000;
    assert.equal((await storeAgentRunReport(a, { patch: { report: REPORT_A, reportHash: 'a'.repeat(64), reportNovelty: 'unchanged' }, previousRunId: first.id }, fixedClock())).outcome, 'stored');
    // The classification could not be read: stored without flags, on the same clock tick.
    const unflagged = await storeUnclassifiedAgentRunReport(b, REPORT_B, fixedClock());
    assert.equal(unflagged?.state, 'report_ready');
    assert.equal(unflagged?.reportNovelty, null);
    assert.deepEqual((await listLatestStoredReports(definition.id, { limit: 1 }, fixedClock())).map(entry => entry.runId), [b.id]);
    assert.equal((await storeReportWithNovelty(await startRun(), REPORT_B, realStore(), silent))?.reportNovelty, 'unchanged');

    const gone = await startRun();
    await transitionAgentRun(gone.id, ['running'], 'cancelled', {}, deps());
    assert.equal(await storeUnclassifiedAgentRunReport(gone, REPORT_B, fixedClock()), null);
  });

  test('the first report of a definition is stored as new', async () => {
    const stored = await storeReportWithNovelty(await startRun(), REPORT_A, realStore(), silent);
    assert.equal(stored?.reportNovelty, 'new');
  });

  test('a run that left running before its report was stored stores nothing', async () => {
    const run = await startRun();
    await transitionAgentRun(run.id, ['running'], 'cancelled', {}, deps());
    assert.equal(await storeReportWithNovelty(run, REPORT_A, realStore(), silent), null);
    assert.equal((await database('agent_runs').where({ id: run.id }).first('report'))?.report, null);
  });

  test('when other reports keep landing in between, the report is stored without flags', async () => {
    const run = await startRun();
    let attempts = 0;
    const store = realStore({ storeReport: async () => { attempts += 1; return { outcome: 'previous_changed' }; } });
    const stored = await storeReportWithNovelty(run, REPORT_A, store, silent);
    assert.equal(attempts, 3);
    assert.equal(stored?.state, 'report_ready');
    assert.equal(stored?.report, REPORT_A);
    assert.equal(stored?.reportNovelty, null);
    assert.equal(stored?.reportHash, null);
  });

  test('an unreadable previous report stores the report without flags', async () => {
    const run = await startRun();
    const store = realStore({ listLatestReports: async () => { throw new Error('database unavailable'); } });
    const stored = await storeReportWithNovelty(run, REPORT_A, store, silent);
    assert.equal(stored?.state, 'report_ready');
    assert.equal(stored?.reportNovelty, null);
  });
});
