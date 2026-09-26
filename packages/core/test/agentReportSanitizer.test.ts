import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAgentReport } from '../src/agents/agentReportSanitizer.js';

test('removes agent-side commit status while retaining implementation and validation details', () => {
    const report = [
        'Implemented the requested recovery fixes.',
        '',
        'Validation: 61 focused tests passed.',
        'Changes are uncommitted. No visual previews needed for these backend changes.',
        'No commits or preview files created.',
    ].join('\n');

    assert.equal(sanitizeAgentReport(report), [
        'Implemented the requested recovery fixes.',
        '',
        'Validation: 61 focused tests passed.',
        'No visual previews needed for these backend changes.',
    ].join('\n'));
});

test('removes permission complaints and inline commit housekeeping', () => {
    const report = [
        'Validation passed; changes remain uncommitted.',
        'I could not create a commit because `.git` is not writable.',
        "The `.git` directory isn't writable, so I was unable to commit.",
        'Updated the error handling for read-only Git metadata.',
    ].join('\n');

    assert.equal(sanitizeAgentReport(report), [
        'Validation passed.',
        'Updated the error handling for read-only Git metadata.',
    ].join('\n'));
});

test('does not rewrite examples inside fenced code blocks', () => {
    const report = [
        'Updated the status fixture:',
        '```text',
        'No commits created.',
        '```',
    ].join('\n');

    assert.equal(sanitizeAgentReport(report), report);
});
