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
import { computeResyncDigest, countResyncOutcomes, decodeResumeResyncRow, encodeResumeResyncRecord } from '../packages/core/src/intake/routingResumeResyncCodec.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-resync-'));
const db = knex({ client: 'better-sqlite3', connection: { filename: path.join(dir, 'store.sqlite') }, useNullAsDefault: true });

after(async () => {
    await db.destroy();
    await closeConnection();
    fs.rmSync(dir, { recursive: true, force: true });
});

const ALL_FAMILIES = ['repository_access', 'task_intents', 'labelled_issues', 'pull_request_comments', 'pull_request_heads', 'merge_conflicts'];
const GITHUB_FAMILIES = ['labelled_issues', 'pull_request_comments', 'pull_request_heads', 'merge_conflicts'];

/** A converged generation: one reconciled repository and one that lost access. */
function completedRecord(): ResumeResyncRecord {
    const base = record({
        state: 'completed', attempts: 3, nextRetryAt: null, lastError: null, consecutiveFailures: 0, installationFamilies: ['ultrafix_continuations'],
        repositories: {
            'acme/api': { status: 'reconciled', completedFamilies: ALL_FAMILIES, inapplicableFamilies: [], access: 'accessible', configured: true, attempts: 2, lastError: null, updatedAt: '2026-10-12T00:59:00.000Z' },
            'acme/gone': { status: 'inaccessible', completedFamilies: ['repository_access', 'task_intents'], inapplicableFamilies: GITHUB_FAMILIES, access: 'inaccessible', configured: true, attempts: 1, lastError: null, updatedAt: '2026-10-12T00:59:00.000Z' },
        },
    });
    base.completion = {
        completionId: 'c-1', completedAt: '2026-10-12T01:00:00.000Z',
        evidence: { repositories: countResyncOutcomes(base.repositories), families: [...ALL_FAMILIES, 'ultrafix_continuations'], attempts: 3, digest: computeResyncDigest(base) },
    };
    return base;
}

function record(overrides: Partial<ResumeResyncRecord> = {}): ResumeResyncRecord {
    return {
        installationId: 42, routingGeneration: 3, resumeGeneration: 7, state: 'partial',
        gapStartedAt: '2026-10-10T00:00:00.000Z', recoveryStartedAt: '2026-10-10T00:00:00.000Z', gapEndedAt: '2026-10-12T00:00:00.000Z',
        attempts: 2, startedAt: '2026-10-12T00:01:00.000Z', lastAttemptAt: '2026-10-12T00:05:00.000Z',
        nextRetryAt: '2026-10-12T00:06:00.000Z', lastError: 'acme/api labelled_issues: GitHub 502',
        repositories: {
            'acme/api': {
                status: 'failed', completedFamilies: ['repository_access', 'task_intents'], inapplicableFamilies: [], access: 'accessible', configured: true,
                attempts: 2, lastError: 'GitHub 502', updatedAt: '2026-10-12T00:05:00.000Z',
            },
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

    const completed = completedRecord();
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
        installationId: 42, store, reconciler: { listRepositories: () => [], listReferencedRepositories: () => [], repositorySteps: [], installationSteps: [] },
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

type Row = ReturnType<typeof encodeResumeResyncRecord>;

function mutateProgress(row: Row, change: (progress: Record<string, any>) => void): Row {
    const progress = JSON.parse(row.progress_json);
    change(progress);
    return { ...row, progress_json: JSON.stringify(progress) };
}

function mutateCompletion(row: Row, change: (completion: Record<string, any>) => void): Row {
    const completion = JSON.parse(row.completion_json as string);
    change(completion);
    return { ...row, completion_json: JSON.stringify(completion) };
}

test('malformed or out-of-bound persisted records fail closed instead of manufacturing reconciled state', () => {
    const partial = encodeResumeResyncRecord(record());
    const completed = encodeResumeResyncRecord(completedRecord());
    assert.deepEqual(decodeResumeResyncRow(completed), completedRecord(), 'the valid records decode unchanged');
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`acme/r${index}`, record().repositories['acme/api']]));
    const cases: Array<[string, Row]> = [
        ['non-positive identity', { ...partial, installation_id: 0 }],
        ['fractional generation', { ...partial, resume_generation: 1.5 }],
        ['malformed gap timestamp', { ...partial, gap_started_at: '2026-10-10' }],
        ['gap ends before it starts', { ...partial, gap_ended_at: '2026-10-09T00:00:00.000Z' }],
        ['missing recovery start', { ...partial, recovery_started_at: null as unknown as string }],
        ['recovery starts after the gap', { ...partial, recovery_started_at: '2026-10-11T00:00:00.000Z' }],
        ['pending with a gap end', { ...partial, state: 'pending' }],
        ['malformed retry timestamp', { ...partial, next_retry_at: 'soon' }],
        ['attempts out of bound', { ...partial, attempts: 10_000_000 }],
        ['oversized error', { ...partial, last_error: 'x'.repeat(5000) }],
        ['progress is not JSON', { ...partial, progress_json: '{' }],
        ['unknown progress field', mutateProgress(partial, progress => { progress.extra = true; })],
        ['unknown repository progress field', mutateProgress(partial, progress => { progress.repositories['acme/api'].trusted = true; })],
        ['unknown family', mutateProgress(partial, progress => { progress.repositories['acme/api'].completedFamilies.push('everything'); })],
        ['duplicate family', mutateProgress(partial, progress => { progress.repositories['acme/api'].completedFamilies.push('task_intents'); })],
        ['local family classified inapplicable', mutateProgress(partial, progress => { progress.repositories['acme/api'].inapplicableFamilies = ['task_intents']; })],
        ['inapplicable without evidence', mutateProgress(partial, progress => { progress.repositories['acme/api'].inapplicableFamilies = ['labelled_issues']; })],
        ['inaccessible status without access evidence', mutateProgress(partial, progress => { progress.repositories['acme/api'].status = 'inaccessible'; })],
        ['unknown repository status', mutateProgress(partial, progress => { progress.repositories['acme/api'].status = 'done'; })],
        ['invalid repository name', mutateProgress(partial, progress => { progress.repositories['../etc'] = progress.repositories['acme/api']; })],
        ['repository bound exceeded', mutateProgress(partial, progress => { progress.repositories = many; })],
        ['negative consecutive failures', mutateProgress(partial, progress => { progress.consecutiveFailures = -1; })],
        ['completion on a partial record', { ...partial, completion_json: completed.completion_json }],
        ['completed without a completion', { ...completed, completion_json: null }],
        ['acknowledged without acknowledgement time', { ...completed, state: 'acknowledged' }],
        ['acknowledgement time while unacknowledged', { ...completed, acknowledged_at: '2026-10-12T02:00:00.000Z' }],
        ['completion digest does not match progress', mutateProgress(completed, progress => { progress.repositories['acme/api'].completedFamilies = ['repository_access']; })],
        ['completion over an unconverged repository', mutateProgress(completed, progress => { progress.repositories['acme/api'].status = 'failed'; })],
        ['evidence counts do not match progress', mutateCompletion(completed, completion => { completion.evidence.repositories = { total: 2, reconciled: 2, inaccessible: 0, unconfigured: 0 }; })],
        ['evidence counts do not sum', mutateCompletion(completed, completion => { completion.evidence.repositories.reconciled = 5; })],
        ['unknown completion field', mutateCompletion(completed, completion => { completion.signature = 'x'; })],
        ['unknown evidence field', mutateCompletion(completed, completion => { completion.evidence.repositoryNames = ['acme/api']; })],
        ['malformed digest', mutateCompletion(completed, completion => { completion.evidence.digest = 'd'; })],
        ['oversized completion id', mutateCompletion(completed, completion => { completion.completionId = 'c'.repeat(200); })],
        ['evidence attempts beyond the record', mutateCompletion(completed, completion => { completion.evidence.attempts = 99; })],
    ];
    for (const [label, row] of cases) {
        assert.throws(() => decodeResumeResyncRow(row), /Unrecognized persisted resume-resync/, label);
    }
});
