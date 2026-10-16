import { after, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import knex from 'knex';
import {
    closeConnection,
    createKnexResumeResyncStore,
    InMemoryResumeResyncStore,
    RoutingResumeResyncCoordinator,
    type ResumeResyncRecord,
} from '@propr/core';
import { down, up } from '../packages/core/src/db/migrations/20261016100000_create_routing_resume_resyncs.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-resync-'));
const db = knex({ client: 'better-sqlite3', connection: { filename: path.join(dir, 'store.sqlite') }, useNullAsDefault: true });

after(async () => {
    await db.destroy();
    await closeConnection();
    fs.rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<ResumeResyncRecord> = {}): ResumeResyncRecord {
    return {
        installationId: 42, routingGeneration: 3, resumeGeneration: 7, state: 'partial',
        gapStartedAt: '2026-10-10T00:00:00.000Z', gapEndedAt: '2026-10-12T00:00:00.000Z',
        attempts: 2, startedAt: '2026-10-12T00:01:00.000Z', lastAttemptAt: '2026-10-12T00:05:00.000Z',
        nextRetryAt: '2026-10-12T00:06:00.000Z', lastError: 'acme/api labelled_issues: GitHub 502',
        repositories: {
            'acme/api': { status: 'failed', completedFamilies: ['repository_access', 'task_intents'], attempts: 2, lastError: 'GitHub 502', updatedAt: '2026-10-12T00:05:00.000Z' },
        },
        installationFamilies: [], consecutiveFailures: 2, completion: null, acknowledgedAt: null,
        updatedAt: '2026-10-12T00:05:00.000Z',
        ...overrides,
    };
}

test('the migration is idempotent and the SQLite store round-trips a record', async () => {
    await up(db);
    await up(db);
    const store = createKnexResumeResyncStore(() => db);
    assert.equal(await store.load(42), null);
    await store.save(record());
    assert.deepEqual(await store.load(42), record());

    const completed = record({
        state: 'completed', nextRetryAt: null, lastError: null, consecutiveFailures: 0, installationFamilies: ['ultrafix_continuations'],
        completion: { completionId: 'c-1', completedAt: '2026-10-12T01:00:00.000Z', evidence: { repositories: { total: 1, reconciled: 1, inaccessible: 0 }, families: ['repository_access'], attempts: 3, digest: 'd' } },
    });
    await store.save(completed);
    assert.deepEqual(await store.load(42), completed, 'an upsert replaces the installation row');
    assert.equal((await db('routing_resume_resyncs').count({ count: '*' }))[0].count, 1);
});

test('a corrupt persisted state fails closed instead of guessing', async () => {
    const store = createKnexResumeResyncStore(() => db);
    await db('routing_resume_resyncs').where({ installation_id: 42 }).update({ state: 'done' });
    await assert.rejects(store.load(42), /Unrecognized persisted resume-resync state/);

    // The coordinator refuses frames while its durable state is unreadable.
    const coordinator = new RoutingResumeResyncCoordinator({
        installationId: 42, store, reconciler: { listRepositories: () => [], repositorySteps: [], installationSteps: [] },
    });
    await coordinator.start();
    const frame = { type: 'resync_required', version: 1, installationId: 42, routingGeneration: 9, resumeGeneration: 1, gapStartedAt: '2026-10-10T00:00:00.000Z', gapEndedAt: '2026-10-12T00:00:00.000Z' };
    await coordinator.handleFrame(frame, 200);
    assert.equal(coordinator.getStatus().lastRejection?.reason, 'state_unavailable');
    await coordinator.stop();
    await down(db);
});

test('the in-memory store isolates saved snapshots from later mutation', async () => {
    const store = new InMemoryResumeResyncStore();
    const value = record();
    await store.save(value);
    value.repositories['acme/api'].completedFamilies.push('labelled_issues');
    assert.deepEqual((await store.load(42))?.repositories['acme/api'].completedFamilies, ['repository_access', 'task_intents']);
});
