import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import knex from 'knex';
import { evalUltrafixScript } from './fixtures/ultrafixRedisDouble.js';
import { startLoop, completeLoop, stopLoop } from '../src/jobs/ultrafixOrchestrationService.js';
import { setUltrafixJournalWriter, ultrafixOutcomeFromCompletion } from '../src/jobs/ultrafixJournal.js';
import { up as createJournal } from '../packages/core/src/db/migrations/20261112160000_create_repository_events.js';
import { appendRepositoryEvent, listRepositoryEvents } from '../packages/core/src/services/repositoryEventJournal.js';

/**
 * Ultrafix start and end are journaled from the loop state service
 * (`startLoop`, `completeLoop`, `stopLoop`), through the writer the daemon and
 * worker install; here it appends to an in-memory journal.
 */
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await createJournal(database);
const writeToTestJournal = async (event: Parameters<typeof appendRepositoryEvent>[1]) => {
    await appendRepositoryEvent(database, event, { publish: false });
};
setUltrafixJournalWriter(writeToTestJournal);
after(async () => { setUltrafixJournalWriter(); await database.destroy(); });
beforeEach(async () => { setUltrafixJournalWriter(writeToTestJournal); await database('repository_events').delete(); });

function createMockRedis() {
    const store = new Map<string, string>();
    return {
        store,
        async get(key: string) { return store.get(key) ?? null; },
        async set(key: string, value: string) { store.set(key, value); return 'OK'; },
        async del(key: string) { store.delete(key); return 1; },
        async eval(script: string, _keyCount: number, ...args: string[]) { return evalUltrafixScript(store, script, args); },
    };
}
const journal = async () => (await listRepositoryEvents(database, { repository: 'acme/web' }))
    .map(event => ({ type: event.type, prNumber: event.prNumber, payload: event.payload }));
const loop = { owner: 'acme', repo: 'web', pr: 42, goal: 8, maxCycles: 4, sourceCommentId: 9001 };

describe('ultrafix journal events', () => {
    test('a loop that reaches its goal journals started and ultrafix_ended once', async () => {
        const redis = createMockRedis();
        await startLoop(redis as never, loop, false);
        const completion = { owner: 'acme', repo: 'web', pr: 42, completionStatus: 'succeeded' as const,
            completionReason: 'Valid review reports no actionable findings and score 9/10 reaches goal 8/10', finalScore: 9 };
        assert.ok(await completeLoop(redis as never, completion));
        // A later stop of the already-completed loop, and a replayed completion, add nothing.
        await stopLoop(redis as never, 'acme', 'web', 42);
        await completeLoop(redis as never, completion);
        assert.deepEqual(await journal(), [
            { type: 'ultrafix_started', prNumber: 42, payload: { goal: 8, maxCycles: 4, workEpoch: 0 } },
            { type: 'ultrafix_ended', prNumber: 42, payload: { outcome: 'goal_reached', finalScore: 9, workEpoch: 0,
                reason: 'Valid review reports no actionable findings and score 9/10 reaches goal 8/10' } },
        ]);
    });

    test('a stopped loop journals the stopped outcome', async () => {
        const redis = createMockRedis();
        await startLoop(redis as never, loop, false);
        await stopLoop(redis as never, 'acme', 'web', 42);
        await stopLoop(redis as never, 'acme', 'web', 42);
        const ended = (await journal()).filter(event => event.type === 'ultrafix_ended');
        assert.equal(ended.length, 1);
        assert.equal(ended[0].payload.outcome, 'stopped');
    });

    test('an explicit outcome wins over the reason, and the reason maps to the coded outcome otherwise', async () => {
        const redis = createMockRedis();
        await startLoop(redis as never, loop, false);
        await completeLoop(redis as never, { owner: 'acme', repo: 'web', pr: 42, completionStatus: 'failed',
            completionReason: 'Max cycles reached: 4 fix steps have completed (limit 4)', finalScore: 6, outcome: 'failed' });
        assert.equal((await journal())[1].payload.outcome, 'failed');

        assert.equal(ultrafixOutcomeFromCompletion('succeeded', 'anything'), 'goal_reached');
        assert.equal(ultrafixOutcomeFromCompletion('failed', 'Max cycles reached: 3 review steps have completed (limit 3)'), 'cycles_exhausted');
        assert.equal(ultrafixOutcomeFromCompletion('failed', 'Invalid review output and max review attempts reached (3)'), 'cycles_exhausted');
        assert.equal(ultrafixOutcomeFromCompletion('failed', 'CI did not settle'), 'failed');
        assert.equal(ultrafixOutcomeFromCompletion('failed', 'The fix step stopped on a blocker'), 'stopped');
    });

    test('a failed journal write does not fail the loop transition', async () => {
        const redis = createMockRedis();
        // The append fails (a database without the journal), and appendRepositoryEvent contains it.
        const broken = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
        setUltrafixJournalWriter(async event => {
            await appendRepositoryEvent(broken, event, { publish: false, log: { warn() {} } as never });
        });
        try {
            const { state } = await startLoop(redis as never, loop, false);
            assert.equal(state.active, true);
            const completed = await completeLoop(redis as never, { owner: 'acme', repo: 'web', pr: 42, completionStatus: 'failed',
                completionReason: 'CI did not settle', finalScore: null });
            assert.equal(completed?.active, false);
            assert.deepEqual(await journal(), []);
        } finally {
            await broken.destroy();
        }
    });
});
