import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    currentHeadChecksHaveFailures,
    formatCurrentHeadCheckSummary,
} from '../src/jobs/reviewCheckSummary.ts';

describe('formatCurrentHeadCheckSummary', () => {
    test('summarizes and orders failed, pending, passed, and neutral checks', () => {
        const summary = formatCurrentHeadCheckSummary([
            { name: 'Validate Changes', status: 'completed', conclusion: 'success' },
            { name: 'Deploy Preview', status: 'completed', conclusion: 'skipped' },
            { name: 'Run Full Test Suite', status: 'completed', conclusion: 'failure' },
            { name: 'Security Scan', status: 'in_progress', conclusion: null },
        ]);

        assert.match(summary, /^Summary: 1 failed, 1 pending, 1 passed, 1 neutral\/skipped\./);
        const failedIndex = summary.indexOf('[failed] Run Full Test Suite');
        const pendingIndex = summary.indexOf('[pending] Security Scan');
        const passedIndex = summary.indexOf('[passed] Validate Changes');
        const neutralIndex = summary.indexOf('[neutral] Deploy Preview');
        assert.ok(failedIndex < pendingIndex && pendingIndex < passedIndex && passedIndex < neutralIndex);
        assert.equal(currentHeadChecksHaveFailures([
            { name: 'Run Full Test Suite', status: 'completed', conclusion: 'failure' },
        ]), true);
    });

    test('classifies terminal non-success conclusions and sanitizes check names', () => {
        const summary = formatCurrentHeadCheckSummary([
            { name: 'Timed\nout check', status: 'completed', conclusion: 'timed_out' },
            { name: '', status: 'queued', conclusion: null },
        ]);

        assert.ok(summary.includes('[failed] Timed out check — status: completed; conclusion: timed_out'));
        assert.ok(summary.includes('[pending] Unnamed check — status: queued; conclusion: none'));
        assert.ok(!summary.includes('Timed\nout'));
        assert.equal(currentHeadChecksHaveFailures([
            { name: 'Security Scan', status: 'in_progress', conclusion: null },
            { name: 'Validate Changes', status: 'completed', conclusion: 'success' },
        ]), false);
    });

    test('reports an empty current-head check set explicitly', () => {
        assert.equal(
            formatCurrentHeadCheckSummary([]),
            'No check runs were reported for the current head commit.',
        );
    });
});
