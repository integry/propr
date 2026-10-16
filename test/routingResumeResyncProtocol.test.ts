import { after, test } from 'node:test';
import assert from 'node:assert';
import { closeConnection, SUPPORTED_WEBHOOK_EVENTS } from '@propr/core';
import {
    INSTALLATION_RESUME_RESYNC_CAPABILITY,
    MAX_RESUME_RESYNC_FRAME_BYTES,
    buildResyncCompleteFrame,
    compareGenerations,
    parseResumeResyncFrame,
} from '../packages/core/src/intake/routingResumeResyncProtocol.js';
import {
    RESUME_RESYNC_RECONCILIATION_MATRIX,
    RESYNC_INSTALLATION_FAMILIES,
    RESYNC_REPOSITORY_FAMILIES,
    ResyncRepositoryInaccessibleError,
    classifyResyncError,
} from '../packages/core/src/intake/routingResumeResyncMatrix.js';

after(async () => {
    await closeConnection();
});

const required = {
    type: 'resync_required',
    version: 1,
    installationId: 42,
    routingGeneration: 3,
    resumeGeneration: 7,
    gapStartedAt: '2026-10-10T00:00:00.000Z',
    gapEndedAt: '2026-10-12T00:00:00.000Z',
};

function parse(frame: Record<string, unknown>) {
    return parseResumeResyncFrame(frame, Buffer.byteLength(JSON.stringify(frame)));
}

test('advertises a versioned capability name', () => {
    assert.equal(INSTALLATION_RESUME_RESYNC_CAPABILITY, 'installation_resume_resync_v1');
});

test('parses resume_pending, resync_required and resync_accepted frames into fresh objects', () => {
    const pending = parse({ ...required, type: 'resume_pending', gapEndedAt: undefined, relayInternal: 'x' });
    assert.deepEqual(pending, {
        ok: true,
        frame: { type: 'resume_pending', installationId: 42, routingGeneration: 3, resumeGeneration: 7, gapStartedAt: '2026-10-10T00:00:00.000Z' },
    });
    const parsed = parse(required);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.frame, {
        type: 'resync_required', installationId: 42, routingGeneration: 3, resumeGeneration: 7,
        gapStartedAt: '2026-10-10T00:00:00.000Z', gapEndedAt: '2026-10-12T00:00:00.000Z',
    });
    const accepted = parse({ type: 'resync_accepted', version: 1, installationId: 42, routingGeneration: 3, resumeGeneration: 7, completionId: 'c-1' });
    assert.deepEqual(accepted.ok && accepted.frame, {
        type: 'resync_accepted', installationId: 42, routingGeneration: 3, resumeGeneration: 7, completionId: 'c-1',
    });
});

test('rejects malformed, unversioned, regressed-interval and oversized frames (fail closed)', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
        [{ ...required, version: 2 }, 'unsupported_version'],
        [{ ...required, version: undefined }, 'unsupported_version'],
        [{ ...required, installationId: '42' }, 'invalid_installation_id'],
        [{ ...required, routingGeneration: 0 }, 'invalid_routing_generation'],
        [{ ...required, resumeGeneration: 1.5 }, 'invalid_resume_generation'],
        [{ ...required, gapStartedAt: '2026-10-10' }, 'invalid_gap_started_at'],
        [{ ...required, gapEndedAt: undefined }, 'invalid_gap_ended_at'],
        [{ ...required, gapEndedAt: '2026-10-09T00:00:00.000Z' }, 'gap_ends_before_start'],
        [{ ...required, type: 'resume_pending' }, 'unexpected_gap_ended_at'],
        [{ type: 'resync_accepted', version: 1, installationId: 42, routingGeneration: 3, resumeGeneration: 7, completionId: '' }, 'invalid_completion_id'],
        [{ ...required, type: 'event' }, 'unknown_type'],
    ];
    for (const [frame, reason] of cases) {
        assert.deepEqual(parse(frame), { ok: false, reason }, JSON.stringify(frame));
    }
    assert.deepEqual(parseResumeResyncFrame(required, MAX_RESUME_RESYNC_FRAME_BYTES + 1), { ok: false, reason: 'oversized_frame' });
});

test('builds an exact-generation resync_complete frame with bounded evidence', () => {
    const frame = buildResyncCompleteFrame(
        { installationId: 42, routingGeneration: 3, resumeGeneration: 7 },
        { gapStartedAt: required.gapStartedAt, gapEndedAt: required.gapEndedAt },
        {
            completionId: 'c-1',
            completedAt: '2026-10-12T01:00:00.000Z',
            evidence: { repositories: { total: 2, reconciled: 1, inaccessible: 1 }, families: ['repository_access'], attempts: 2, digest: 'abc' },
        },
    );
    assert.deepEqual(frame, {
        type: 'resync_complete', version: 1, installationId: 42, routingGeneration: 3, resumeGeneration: 7,
        completionId: 'c-1', gapStartedAt: required.gapStartedAt, gapEndedAt: required.gapEndedAt,
        completedAt: '2026-10-12T01:00:00.000Z',
        evidence: { repositories: { total: 2, reconciled: 1, inaccessible: 1 }, families: ['repository_access'], attempts: 2, digest: 'abc' },
    });
});

test('orders generations by routing generation first, then resume generation', () => {
    const at = (routingGeneration: number, resumeGeneration: number) => ({ installationId: 1, routingGeneration, resumeGeneration });
    assert.ok(compareGenerations(at(2, 1), at(1, 9)) > 0);
    assert.ok(compareGenerations(at(1, 2), at(1, 3)) < 0);
    assert.equal(compareGenerations(at(1, 3), at(1, 3)), 0);
});

test('every supported webhook event is recovered or explicitly documented as unrecoverable', () => {
    const families = new Set<string>([...RESYNC_REPOSITORY_FAMILIES, ...RESYNC_INSTALLATION_FAMILIES]);
    for (const event of SUPPORTED_WEBHOOK_EVENTS) {
        const rows = RESUME_RESYNC_RECONCILIATION_MATRIX.filter(row => row.event === event);
        assert.ok(rows.length > 0, `${event} has no reconciliation matrix entry`);
    }
    for (const row of RESUME_RESYNC_RECONCILIATION_MATRIX) {
        if (row.family === null) assert.match(row.note, /^Unrecoverable:/, `${row.event} ${row.transitions}`);
        else assert.ok(families.has(row.family), `${row.family} is not an implemented family`);
    }
    // Every implemented family recovers at least one documented transition.
    for (const family of families) {
        if (family === 'repository_access') continue;
        assert.ok(RESUME_RESYNC_RECONCILIATION_MATRIX.some(row => row.family === family), `${family} is undocumented`);
    }
});

test('classifies inaccessible repositories, rate limits and other failures', () => {
    const now = 1_000_000;
    assert.deepEqual(classifyResyncError(new ResyncRepositoryInaccessibleError('o/r', 404), now), { kind: 'inaccessible' });
    assert.deepEqual(classifyResyncError({ status: 429, response: { headers: { 'retry-after': '30' } } }, now), { kind: 'rate_limited', retryAt: now + 30_000 });
    assert.deepEqual(
        classifyResyncError({ status: 403, message: 'x', response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 120) } } }, now),
        { kind: 'rate_limited', retryAt: now + 120_000 },
    );
    assert.deepEqual(classifyResyncError({ status: 403, message: 'API rate limit exceeded' }, now), { kind: 'rate_limited', retryAt: now + 60_000 });
    // A plain 403 (e.g. the suspension itself) and a 404 from a deep step are ordinary failures.
    assert.deepEqual(classifyResyncError({ status: 403, message: 'This installation has been suspended' }, now), { kind: 'failed' });
    assert.deepEqual(classifyResyncError({ status: 404 }, now), { kind: 'failed' });
    assert.deepEqual(classifyResyncError(new Error('boom'), now), { kind: 'failed' });
});
