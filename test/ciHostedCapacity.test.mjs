import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { decideOverflow } from '../scripts/ci-hosted-capacity.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/ci-hosted-capacity.mjs', import.meta.url));
const now = Date.parse('2026-09-28T12:00:00Z');
const ago = seconds => new Date(now - seconds * 1000).toISOString();
const running = (count, labels = ['ubuntu-latest']) => Array.from({ length: count }, () => ({ status: 'in_progress', labels, created_at: ago(300) }));

describe('hosted capacity overflow decision', () => {
    test('stays hosted while running and planned jobs fit below the limit minus the reserve', () => {
        const decision = decideOverflow({ jobs: running(29), now, planned: 5 });
        assert.equal(decision.overflow, false);
        assert.equal(decision.capacity, 34);
        assert.equal(decideOverflow({ jobs: running(30), now, planned: 5 }).overflow, true, '30 + 5 exceeds 34');
    });

    test('counts every hosted job, including macOS and Windows, but never self-hosted ones', () => {
        const jobs = [...running(20), ...running(5, ['macos-15']), ...running(5, ['windows-2025']), ...running(30, ['self-hosted', 'Linux', 'X64', 'propr-rootless'])];
        const decision = decideOverflow({ jobs, now, planned: 5 });
        assert.equal(decision.running, 30);
        assert.equal(decision.overflow, true);
    });

    test('overflows as soon as a hosted Linux job has waited for a runner', () => {
        const waiting = { status: 'queued', labels: ['ubuntu-latest'], created_at: ago(90) };
        assert.equal(decideOverflow({ jobs: [waiting], now, planned: 1 }).overflow, true);
        assert.equal(decideOverflow({ jobs: [{ ...waiting, created_at: ago(10) }], now, planned: 1 }).overflow, false, 'a job that was just queued is normal');
        assert.equal(decideOverflow({ jobs: [{ ...waiting, labels: ['macos-15'] }], now, planned: 1 }).overflow, false, 'macOS has its own limit');
        assert.equal(decideOverflow({ jobs: [{ ...waiting, labels: ['self-hosted', 'propr-rootless'] }], now, planned: 1 }).overflow, false, 'a busy rootless pool is not hosted saturation');
        assert.equal(decideOverflow({ jobs: [{ ...waiting, status: 'waiting' }], now, planned: 1 }).overflow, false, 'environment approvals are not capacity');
        assert.equal(decideOverflow({ jobs: [{ ...waiting, created_at: undefined }], now, planned: 1 }).overflow, false);
    });

    test('honours a configured limit', () => {
        assert.equal(decideOverflow({ jobs: running(10), now, planned: 5, limit: 20 }).overflow, true);
        assert.equal(decideOverflow({ jobs: running(10), now, planned: 5, limit: 60 }).overflow, false);
    });

    test('never fails the job and keeps checks hosted when the API cannot be read', () => {
        const directory = mkdtempSync(join(tmpdir(), 'propr-hosted-capacity-'));
        try {
            const output = join(directory, 'output');
            const result = spawnSync(process.execPath, [SCRIPT], {
                encoding: 'utf8',
                env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'integry/propr' },
            });
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /::warning::Hosted capacity check failed, keeping checks hosted/);
            assert.equal(readFileSync(output, 'utf8'), 'overflow=false\n');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
