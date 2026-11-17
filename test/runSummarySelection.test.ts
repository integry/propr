import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import type { ExecutionResult } from '../packages/core/src/claude/docker/dockerExecutor.js';
import { processDockerResult } from '../packages/core/src/agents/impl/utils/dockerResultProcessor.js';
import { isRunStatusNote, NO_AGENT_SUMMARY_TEXT, reportsUnfinishedWork, selectRunSummary } from '../packages/core/src/agents/impl/utils/runSummary.js';
import { agentResultToClaudeResponse } from '../src/jobs/prFileUtils.js';
import { buildCommitMessage } from '../src/jobs/prCommentJobUtils.js';
import { buildCompletionComment } from '../src/jobs/prCompletionComment.js';

after(async () => {
    await closeConnection();
});

type Line = Record<string, unknown>;
let messageCounter = 0;
const assistantText = (text: string): Line => ({ type: 'assistant', message: { id: `msg_${++messageCounter}`, model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });
const toolUse = (id: string, text = ''): Line => ({
    type: 'assistant',
    message: { id: `msg_${++messageCounter}`, content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name: 'Bash', input: {} }] },
});
const toolResult = (id: string): Line => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const notification = (summary: string): Line => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: `<task-notification>\n<task-id>bg1</task-id>\n<status>timed_out</status>\n<summary>${summary}</summary>\n</task-notification>` }] },
});
const result = (text: string): Line => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's1', total_cost_usd: 1.5, usage: { input_tokens: 10, output_tokens: 5 } });

function execution(lines: Line[]): ExecutionResult {
    return { exitCode: 0, stdout: `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, stderr: '', messageTimestamps: new Map() };
}

const SUMMARY = [
    'Fixed the epic queue so an issue behind a skipped predecessor waits for unfinished earlier issues.',
    '',
    '- `packages/core/src/plans/epicQueue.ts`: skipped issues no longer satisfy ordering for later issues.',
    '- `/issues` now reports the skipped state and dependency list.',
    '- Added tests for the skipped-predecessor ordering; all 28 related suites pass.',
].join('\n');

const MONITOR_REPLY = "The monitor timed out after the batch had already finished, so I don't need to restart it. All 28 related suites passed, and my summary above still holds.";

describe('run summary selection', () => {
    test('a reply to a late monitor notification does not replace the summary', () => {
        const { response } = processDockerResult(execution([
            toolUse('t1', 'Running the related suites in the background.'),
            toolResult('t1'),
            assistantText(SUMMARY),
            notification('Monitor "suites" timed out'),
            assistantText(MONITOR_REPLY),
            result(MONITOR_REPLY),
        ]), 'prompt', 'claude-opus-5-5', 1);

        assert.equal(response.success, true);
        assert.equal(response.terminationReason, undefined);
        assert.equal(response.summary, SUMMARY);
        assert.equal(response.commitMessage?.split('\n')[0], SUMMARY.split('\n')[0]);
    });

    test('an earlier result line holds the summary when the stream continues after it', () => {
        const reply = 'That timeout notice came from the watcher I set on the check run, and it doesn\'t change anything.';
        const { response } = processDockerResult(execution([
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY), result(SUMMARY),
            notification('Watcher timed out'),
            assistantText(reply), result(reply),
        ]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.summary, SUMMARY);
    });

    test('"Summarizing now." falls back to the most substantive recent message', () => {
        const status = 'Verification is complete. Summarizing now.';
        const { response } = processDockerResult(execution([
            toolUse('t1'), toolResult('t1'),
            toolUse('t2', SUMMARY), toolResult('t2'),
            assistantText(status), result(status),
        ]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.summary, SUMMARY);
        assert.notEqual(response.commitMessage?.split('\n')[0], status);
    });

    test('a reply that only reports a notification and has no earlier summary yields no summary', () => {
        const reply = 'That notification is the depth-measurement probe I started earlier; nothing else to do.';
        const { response } = processDockerResult(execution([
            toolUse('t1', 'Starting the probe.'), toolResult('t1'),
            notification('probe finished'),
            assistantText(reply), result(reply),
        ]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.summary, undefined);
        assert.equal(response.commitMessage, null);
        assert.equal(response.success, true);
    });

    test('a last message that is still waiting for running work is an unfinished run', () => {
        const waiting = 'Summary: Still running (7 of ~110 suites done). Waiting for the completion notification.';
        const { response } = processDockerResult(execution([
            toolUse('t1', 'Starting the full suite in the background.'), toolResult('t1'),
            assistantText(waiting), result(waiting),
        ]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, false);
        assert.equal(response.terminationReason, 'unfinished_work');
        assert.match(response.error ?? '', /still waiting for work it had started/);
        assert.match(response.error ?? '', /7 of ~110 suites done/);
        assert.equal(response.summary, undefined);
    });

    test('a substantive summary written after a notification is kept', () => {
        const fresh = `${SUMMARY}\n- After the background run finished, fixed the one failing assertion it reported.`;
        const { response } = processDockerResult(execution([
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY),
            notification('suite failed'),
            toolUse('t2', 'One suite failed; fixing it.'), toolResult('t2'),
            assistantText(fresh), result(fresh),
        ]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.summary, fresh);
    });

    test('a short summary written after fixing a notified failure is kept', () => {
        const fixed = 'Fixed the failing retry assertion. All 28 suites now pass.';
        const { response } = processDockerResult(execution([
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY),
            notification('suite failed'),
            toolUse('t2', 'One suite failed; fixing it.'), toolResult('t2'),
            toolUse('t3'), toolResult('t3'),
            assistantText(fixed), result(fixed),
        ]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.summary, fixed);
        assert.equal(response.success, true);
        assert.equal(response.commitMessage?.split('\n')[0], fixed);
        assert.equal(isRunStatusNote('Fixed the failing retry assertion; all 28 suites now pass.', { afterNotification: true }), false);
        assert.equal(isRunStatusNote('Fixed the timeout in the retry test; all suites pass.', { afterNotification: true }), false);
        assert.equal(isRunStatusNote('Nothing else to do.', { afterNotification: true }), true);
    });

    test('a new fix summary that also points back to the earlier summary is kept', () => {
        const fixed = 'Fixed the retry assertion exposed by the background run. All 28 suites now pass. The earlier summary still applies.';
        const conversationLog = [
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY),
            notification('suite failed'),
            toolUse('t2', 'One suite failed; fixing it.'), toolResult('t2'),
            assistantText(fixed),
        ];
        assert.equal(isRunStatusNote(fixed, { afterNotification: true }), false);
        assert.equal(isRunStatusNote(fixed), false);
        assert.equal(isRunStatusNote('Fixed the retry assertion; nothing else to do.', { afterNotification: true }), false);
        // Back-references without a reported change stay status notes.
        assert.equal(isRunStatusNote('All 28 suites now pass. The earlier summary still applies.', { afterNotification: true }), true);
        assert.equal(isRunStatusNote('All 28 suites now pass. The earlier summary still applies.'), true);

        const { response } = processDockerResult(execution([...conversationLog, result(fixed)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.summary, fixed);
        assert.equal(response.commitMessage?.split('\n')[0], fixed);
        assert.equal(selectRunSummary({ conversationLog }).summary, fixed);

        const claudeResult = agentResultToClaudeResponse({
            success: true, model: 'claude-opus-5-5', executionTimeMs: 1000, logs: '', exitCode: 0, modelUsed: 'claude-opus-5-5',
            modifiedFiles: ['a.ts'], commitMessage: null, summary: fixed, conversationLog,
        });
        const commitMessage = buildCommitMessage({
            changesSummary: fixed, unprocessedComments: [], pullRequestNumber: 12, claudeResult, llm: 'claude-opus-5-5', authorsText: '@octo',
        });
        assert.notEqual(commitMessage.split('\n')[0], 'feat(ai): Apply follow-up changes from PR comment');
        assert.match(commitMessage, /Fixed the retry assertion exposed by the background run/);
    });

    test('an inline-labelled fix summary written after a notified failure is kept', () => {
        const fixed = 'Summary: Fixed the timeout in worker.ts. All 28 suites now pass.';
        const conversationLog = [
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY),
            notification('suite failed'),
            toolUse('t2', 'One suite timed out; fixing it.'), toolResult('t2'),
            toolUse('t3'), toolResult('t3'),
            assistantText(fixed),
        ];
        assert.equal(isRunStatusNote(fixed, { afterNotification: true }), false);
        assert.equal(isRunStatusNote(fixed), false);
        for (const label of ['Status: ', 'Update:', '**Summary:** ', 'Progress : ']) {
            const labelled = `${label}Fixed the timeout in worker.ts. All 28 suites now pass.`;
            assert.equal(isRunStatusNote(labelled, { afterNotification: true }), false, labelled);
        }
        // A label in front of a notification-only reply does not make it a report.
        assert.equal(isRunStatusNote('Summary: The watcher timed out after the suites finished; nothing else to do.', { afterNotification: true }), true);

        const { response } = processDockerResult(execution([...conversationLog, result(fixed)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, true);
        assert.equal(response.summary, fixed);
        assert.match(response.commitMessage?.split('\n')[0] ?? '', /Fixed the timeout in worker\.ts/);
        assert.equal(selectRunSummary({ resultText: fixed, conversationLog }).summary, fixed);
        assert.equal(selectRunSummary({ conversationLog }).summary, fixed);

        const claudeResult = agentResultToClaudeResponse({
            success: true, model: 'claude-opus-5-5', executionTimeMs: 1000, logs: '', exitCode: 0, modelUsed: 'claude-opus-5-5',
            modifiedFiles: ['worker.ts'], commitMessage: response.commitMessage ?? null, summary: response.summary, conversationLog,
        });
        const commitMessage = buildCommitMessage({
            changesSummary: fixed, unprocessedComments: [], pullRequestNumber: 12, claudeResult, llm: 'claude-opus-5-5', authorsText: '@octo',
        });
        assert.notEqual(commitMessage.split('\n')[0], 'feat(ai): Apply follow-up changes from PR comment');
        assert.match(commitMessage.split('\n')[0], /Fixed the timeout in worker\.ts/);
        assert.doesNotMatch(commitMessage, /epic queue/);
    });

    test('a newer concise fix summary beats an older long one when the last reply is a status note', () => {
        const fixed = 'Fixed the retry assertion. All 28 suites now pass.';
        const status = 'The monitor expired; my summary above still holds.';
        const conversationLog = [
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY),
            notification('suite failed'),
            toolUse('t2', 'One suite failed; fixing it.'), toolResult('t2'),
            assistantText(fixed),
            notification('Monitor "suites" timed out'),
            assistantText(status),
        ];
        const { response } = processDockerResult(execution([...conversationLog, result(status)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, true);
        assert.equal(response.summary, fixed);
        assert.equal(response.commitMessage?.split('\n')[0], fixed);
        assert.equal(selectRunSummary({ resultText: status, conversationLog }).summary, fixed);
        assert.equal(selectRunSummary({ conversationLog }).summary, fixed);
    });

    test('a long notification reply rejected as a summary does not return through the recent-message fallback', () => {
        const watcherReply = `The watcher timed out. ${'It was the background watcher on the full suite, which had already reported its last batch before the limit, so the timeout says nothing about the code and needs no re-arming. '.repeat(3)}`.trim();
        assert.ok(watcherReply.length > 320);
        const status = 'Verification is complete. Summarizing now.';
        const conversationLog = [
            toolUse('t1', 'Starting the full suite in the background.'), toolResult('t1'),
            notification('Watcher timed out'),
            assistantText(watcherReply),
            notification('Monitor "suites" timed out'),
            assistantText(status),
        ];
        const { response } = processDockerResult(execution([...conversationLog, result(status)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.summary, undefined);
        assert.equal(response.commitMessage, null);
        assert.equal(selectRunSummary({ resultText: status, conversationLog }).summary, null);
    });

    for (const [label, status] of [
        ['a heading', '## Summary\n\nVerification is complete. Summarizing now.'],
        ['a bullet', '- Verification is complete.\n- Summarizing now.'],
        ['bold text', '**Summary:** Verification is complete. Summarizing now.'],
    ]) {
        test(`a summary announcement formatted with ${label} is not published`, async () => {
            assert.equal(isRunStatusNote(status), true);
            const { response } = processDockerResult(execution([
                toolUse('t1', 'Running the related suites.'), toolResult('t1'),
                assistantText(status), result(status),
            ]), 'prompt', 'claude-opus-5-5', 1);
            assert.equal(response.success, true);
            assert.equal(response.summary, undefined);
            assert.equal(response.commitMessage, null);

            const claudeResult = agentResultToClaudeResponse({
                success: true, model: 'claude-opus-5-5', executionTimeMs: 1000, logs: '', exitCode: 0, modelUsed: 'claude-opus-5-5',
                modifiedFiles: ['a.ts'], commitMessage: null, summary: status,
                conversationLog: [toolUse('t1', 'Running the related suites.'), toolResult('t1'), assistantText(status)],
            });
            const commitMessage = buildCommitMessage({
                changesSummary: status, unprocessedComments: [], pullRequestNumber: 12, claudeResult, llm: 'claude-opus-5-5', authorsText: '@octo',
            });
            assert.equal(commitMessage.split('\n')[0], 'feat(ai): Apply follow-up changes from PR comment');
            const body = await buildCompletionComment({ commitHash: 'abcdef1234567' }, [], {
                changesSummary: status, commitMessage, llm: 'claude-opus-5-5', authorsText: '@octo',
            }, claudeResult);
            assert.doesNotMatch(body, /Summarizing now/);
            assert.match(body, new RegExp(NO_AGENT_SUMMARY_TEXT.replace('.', '\\.')));
        });
    }

    test('a formatted summary with substance and an announcement is kept', () => {
        const formatted = '## Summary\n\nFixed the retry backoff in the worker. Summarizing now.';
        assert.equal(isRunStatusNote(formatted), false);
        assert.equal(isRunStatusNote(`## Summary\n\n${SUMMARY}`), false);
    });

    test('a new summary that opens with the notification keeps the fix it reports', async () => {
        const fresh = 'The watcher exposed a retry bug.\n\n- Fixed retry handling in the worker.\n- Added a regression test; all suites pass.';
        const conversationLog = [
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY),
            notification('Watcher reported a failure'),
            toolUse('t2', 'Looking at the failure.'), toolResult('t2'),
            toolUse('t3'), toolResult('t3'),
            assistantText(fresh),
        ];
        assert.equal(isRunStatusNote(fresh, { afterNotification: true }), false);
        assert.equal(isRunStatusNote('The watcher timed out; I\'ve fixed the retry handling it exposed.', { afterNotification: true }), false);
        assert.equal(isRunStatusNote('The watcher timed out after the suites finished, so it says nothing about the code.', { afterNotification: true }), true);

        const { response } = processDockerResult(execution([...conversationLog, result(fresh)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, true);
        assert.equal(response.summary, fresh);
        assert.equal(response.commitMessage?.split('\n')[0], 'The watcher exposed a retry bug.');
        // Without a reported result, the recent-message fallback and the
        // comment's conversation summary keep the same answer.
        assert.equal(selectRunSummary({ conversationLog }).summary, fresh);

        const claudeResult = agentResultToClaudeResponse({
            success: true, model: 'claude-opus-5-5', executionTimeMs: 1000, logs: '', exitCode: 0, modelUsed: 'claude-opus-5-5',
            modifiedFiles: ['a.ts'], commitMessage: null, summary: undefined, conversationLog,
        });
        const body = await buildCompletionComment({ commitHash: 'abcdef1234567' }, [], {
            changesSummary: '', commitMessage: 'feat(ai): Apply follow-up changes from PR comment', llm: 'claude-opus-5-5', authorsText: '@octo',
        }, claudeResult);
        assert.match(body, /Fixed retry handling in the worker/);
    });

    for (const [label, waiting] of [
        ['a heading', '## Summary\n\nStill running (7 of ~110 suites done). Waiting for the completion notification.'],
        ['a bullet', '- Still running (7 of ~110 suites done). Waiting for the completion notification.'],
        ['bold text', '**Status:** still running (7 of ~110 suites done); waiting for the completion notification.'],
    ]) {
        test(`a waiting message formatted with ${label} is an unfinished run`, () => {
            const { response } = processDockerResult(execution([
                toolUse('t1', 'Starting the full suite in the background.'), toolResult('t1'),
                assistantText(waiting), result(waiting),
            ]), 'prompt', 'claude-opus-5-5', 1);
            assert.equal(response.success, false);
            assert.equal(response.terminationReason, 'unfinished_work');
            assert.equal(response.summary, undefined);
            assert.equal(response.commitMessage, null);
        });
    }

    test('a completed change that quotes waiting wording is not an unfinished run', () => {
        for (const done of [
            'Changed the status label to \u2018Waiting for the completion notification\u2019.',
            'Changed the status label to "Still running" while the suite executes.',
            'Changed the status label so it reads Waiting for the completion notification.',
        ]) {
            const { response } = processDockerResult(execution([toolUse('t1'), toolResult('t1'), assistantText(done), result(done)]), 'prompt', 'claude-opus-5-5', 1);
            assert.equal(response.success, true, done);
            assert.equal(response.terminationReason, undefined, done);
            assert.equal(response.summary, done);
            assert.equal(reportsUnfinishedWork(done), false, done);
        }
    });

    test('a completed change that quotes waiting wording in a blockquote or fence is not an unfinished run', () => {
        for (const done of [
            'Updated the progress message to:\n\n> Waiting for the completion notification.',
            'Updated the progress message to:\n\n> > Still running the suites.',
            'Updated the progress message to:\n\n```\nWaiting for the completion notification.\n```',
            'Updated the progress message to:\n\n~~~text\nStill running (7 of ~110 suites done).\n~~~',
        ]) {
            assert.equal(reportsUnfinishedWork(done), false, done);
            const { response } = processDockerResult(execution([toolUse('t1'), toolResult('t1'), assistantText(done), result(done)]), 'prompt', 'claude-opus-5-5', 1);
            assert.equal(response.success, true, done);
            assert.equal(response.terminationReason, undefined, done);
            assert.equal(response.summary, done);
        }
        // The agent's own prose around a quoted example still counts.
        assert.equal(reportsUnfinishedWork('Still running the suites. The progress message reads:\n\n> Working.'), true);
        assert.equal(reportsUnfinishedWork('```\nnpm test\n```\n\nWaiting for the completion notification.'), true);
    });

    test('ordinary runs keep the reported result unchanged', () => {
        const short = 'Fixed the typo in README.md.';
        const { response } = processDockerResult(execution([toolUse('t1'), toolResult('t1'), assistantText(short), result(short)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.summary, short);
        assert.equal(response.success, true);
        assert.equal(response.terminationReason, undefined);
    });

    test('a completed change that names a summary is kept as the summary and commit subject', () => {
        for (const fixed of ['Fixed the previous summary rendering.', 'Updated the earlier summary wording in the README.']) {
            const { response } = processDockerResult(execution([toolUse('t1'), toolResult('t1'), assistantText(fixed), result(fixed)]), 'prompt', 'claude-opus-5-5', 1);
            assert.equal(response.success, true, fixed);
            assert.equal(response.summary, fixed);
            assert.equal(response.commitMessage?.split('\n')[0], fixed);
            assert.equal(isRunStatusNote(fixed), false, fixed);
            assert.equal(isRunStatusNote(fixed, { afterNotification: true }), false, fixed);

            const claudeResult = agentResultToClaudeResponse({
                success: true, model: 'claude-opus-5-5', executionTimeMs: 1000, logs: '', exitCode: 0, modelUsed: 'claude-opus-5-5',
                modifiedFiles: ['a.ts'], commitMessage: response.commitMessage ?? null, summary: response.summary,
            });
            const commitMessage = buildCommitMessage({
                changesSummary: fixed, unprocessedComments: [], pullRequestNumber: 12, claudeResult, llm: 'claude-opus-5-5', authorsText: '@octo',
            });
            assert.equal(commitMessage.split('\n')[0], `feat(ai): ${fixed}`);
        }
        // A sentence that only points back at a summary is still a status note.
        assert.equal(isRunStatusNote('The previous summary still holds.'), true);
    });

    test('a plan for a future event is not unfinished work', () => {
        const done = 'Fixed the retry bug. I\'ll update the changelog after the next release.';
        const { response } = processDockerResult(execution([toolUse('t1'), toolResult('t1'), assistantText(done), result(done)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, true);
        assert.equal(response.terminationReason, undefined);
        assert.equal(response.summary, done);
        for (const plan of [
            'I\'ll update the changelog after the next release.',
            'I will post the migration notes when the release is done.',
            'I\'ll report the numbers to the team after the meeting.',
        ]) assert.equal(reportsUnfinishedWork(plan), false, plan);
    });

    test('a promise to report once running work finishes is still unfinished work', () => {
        for (const waiting of [
            'I\'ll keep waiting for the completion notification.',
            'I\'ll report back once the suites finish.',
            'I\'ll summarize the results when the full test suite is done.',
            'Will follow up after the background build finishes.',
            'I\'ll post the results when they complete.',
        ]) assert.equal(reportsUnfinishedWork(waiting), true, waiting);

        const waiting = 'Started the full suite in the background. I\'ll report back once it finishes.';
        const { response } = processDockerResult(execution([toolUse('t1'), toolResult('t1'), assistantText(waiting), result(waiting)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, false);
        assert.equal(response.terminationReason, 'unfinished_work');
    });

    test('a declarative summary that names an earlier summary is kept', () => {
        const declarative = 'The previous summary rendering now handles empty responses.';
        const { response } = processDockerResult(execution([toolUse('t1'), toolResult('t1'), assistantText(declarative), result(declarative)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, true);
        assert.equal(response.summary, declarative);
        assert.equal(response.commitMessage?.split('\n')[0], declarative);
        assert.equal(isRunStatusNote(declarative), false);
        assert.equal(isRunStatusNote(declarative, { afterNotification: true }), false);
        assert.equal(selectRunSummary({ conversationLog: [toolUse('t1'), toolResult('t1'), assistantText(declarative)] }).summary, declarative);
        for (const ordinary of [
            'The README now documents the retry limit.',
            'Retries now back off exponentially, capped at 30 seconds.',
            'The earlier report page now loads in under a second.',
        ]) assert.equal(isRunStatusNote(ordinary), false, ordinary);
    });

    test('a declarative summary written after a notification replaces the older summary', () => {
        const fresh = 'The background job now retries failed requests up to three times. Regression tests pass.';
        const conversationLog = [
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY),
            notification('suite failed'),
            toolUse('t2', 'One suite failed; fixing it.'), toolResult('t2'),
            assistantText(fresh),
        ];
        assert.equal(isRunStatusNote(fresh, { afterNotification: true }), false);
        assert.equal(isRunStatusNote('The watcher reported a failure. Retries now stop after three attempts.', { afterNotification: true }), false);
        // Wording about the notification event itself is still a reply to it.
        assert.equal(isRunStatusNote('The background job timed out after the suites finished.', { afterNotification: true }), true);
        assert.equal(isRunStatusNote('The background job now retries failed requests. My summary above still holds.', { afterNotification: true }), false);

        const { response } = processDockerResult(execution([...conversationLog, result(fresh)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, true);
        assert.equal(response.summary, fresh);
        assert.match(response.commitMessage?.split('\n')[0] ?? '', /^The background job now retries failed requests/);
        assert.equal(selectRunSummary({ conversationLog }).summary, fresh);
    });

    test('a product description of a background job written after a notification replaces the older summary', () => {
        const fresh = 'The background job is a persistent worker that retries failed requests.';
        const conversationLog = [
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY),
            notification('background job failed'),
            toolUse('t2', 'Failed requests were dropped; fixing it.'), toolResult('t2'),
            assistantText(fresh),
        ];
        for (const declarative of [
            fresh,
            'The background job was a one-shot script; it is now a persistent worker.',
            'The monitor is the only place that tracks lease renewals.',
        ]) assert.equal(isRunStatusNote(declarative, { afterNotification: true }), false, declarative);
        // Identifying the notification itself is still a reply to it.
        for (const reply of [
            'That notification is the depth-measurement probe I started earlier.',
            'The notification was from the background suite I started earlier.',
            'The timeout was just the watcher on the full suite.',
        ]) assert.equal(isRunStatusNote(reply, { afterNotification: true }), true, reply);

        const { response } = processDockerResult(execution([...conversationLog, result(fresh)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, true);
        assert.equal(response.summary, fresh);
        assert.equal(response.commitMessage?.split('\n')[0], fresh);
        assert.equal(selectRunSummary({ conversationLog }).summary, fresh);
    });

    test('a declarative summary whose subordinate clause names a notification event replaces the older summary', () => {
        const fresh = 'The background job now retries requests that timed out.';
        const conversationLog = [
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY),
            notification('background job failed'),
            toolUse('t2', 'Requests that timed out were dropped; fixing it.'), toolResult('t2'),
            assistantText(fresh),
        ];
        assert.equal(isRunStatusNote(fresh, { afterNotification: true }), false);
        for (const declarative of [
            'The background job now skips uploads whose checksum expired.',
            'The monitor now restarts any worker when its lease expired.',
            'The requests that background jobs timed out are now retried.',
            'It was the retry that background jobs needed.',
        ]) assert.equal(isRunStatusNote(declarative, { afterNotification: true }), false, declarative);
        // The notifier's own predicate is still a reply to the notification.
        for (const reply of [
            'The background job I started earlier timed out.',
            'The background job, which I started earlier, timed out.',
            'The watcher I set on the check run finished.',
        ]) assert.equal(isRunStatusNote(reply, { afterNotification: true }), true, reply);

        const { response } = processDockerResult(execution([...conversationLog, result(fresh)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, true);
        assert.equal(response.summary, fresh);
        assert.equal(response.commitMessage?.split('\n')[0], fresh);
        assert.equal(selectRunSummary({ conversationLog }).summary, fresh);
    });

    test('a watcher reply that quotes the task name does not replace the summary', () => {
        const reply = 'The watcher `full-suite` timed out; nothing else to do.';
        const { response } = processDockerResult(execution([
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY),
            notification('Watcher "full-suite" timed out'),
            assistantText(reply), result(reply),
        ]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, true);
        assert.equal(response.summary, SUMMARY);
        assert.equal(response.commitMessage?.split('\n')[0], SUMMARY.split('\n')[0]);
        for (const quoted of [
            'The watcher "full-suite" timed out; nothing else to do.',
            'The \u201cfull-suite\u201d watcher timed out.',
            "The monitor 'full-suite' only expired; it doesn't need re-arming.",
            'The `full-suite` watcher finished. My summary above still holds.',
        ]) assert.equal(isRunStatusNote(quoted, { afterNotification: true }), true, quoted);
        // A quoted task name in a still-waiting note keeps the note one sentence.
        assert.equal(reportsUnfinishedWork('Waiting for the `full-suite` run to finish.'), true);
        // Quoted text is still product text, and a quote that ends a sentence still ends it.
        assert.equal(isRunStatusNote('Changed the label to "Waiting for the notification".', { afterNotification: true }), false);
        assert.equal(isRunStatusNote('Set the banner to "Done." Summarizing now.'), false);
        assert.equal(isRunStatusNote('The watcher said "Done." Summarizing now.'), false);
    });

    test('a watcher reply after a second result line without a notification does not replace the summary', () => {
        const reply = 'The watcher timed out after the suites finished; nothing else to do.';
        const lines = [
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY), result(SUMMARY),
            assistantText(reply), result(reply),
        ];
        const { response } = processDockerResult(execution(lines), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.success, true);
        assert.equal(response.summary, SUMMARY);
        assert.equal(response.commitMessage?.split('\n')[0], SUMMARY.split('\n')[0]);

        // A substantive answer after the boundary is still the newest summary.
        const fixed = 'The retry limit is now three attempts, and the regression test covers it.';
        const { response: kept } = processDockerResult(execution([
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY), result(SUMMARY),
            toolUse('t2'), toolResult('t2'),
            assistantText(fixed), result(fixed),
        ]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(kept.summary, fixed);
    });

    test('the completion comment keeps the summary core chose across a second result line', async () => {
        // No notification is logged: only the result boundary marks the
        // labelled watcher reply as a reply, so the comment must see it too.
        const reply = 'Summary: The watcher timed out after the suites finished; nothing else to do.';
        const { response } = processDockerResult(execution([
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY), result(SUMMARY),
            assistantText(reply), result(reply),
        ]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.summary, SUMMARY);
        // The prompt is prepended to the published log; the boundary follows it.
        assert.equal(response.conversationLog?.[response.resultLogIndexes![1] - 1]?.message?.content?.[0]?.text, reply);

        const claudeResult = agentResultToClaudeResponse({ ...response, modifiedFiles: ['epicQueue.ts'] });
        assert.deepEqual(claudeResult.resultLogIndexes, response.resultLogIndexes);
        const body = await buildCompletionComment({ commitHash: 'abcdef1234567' }, [], {
            changesSummary: SUMMARY, commitMessage: response.commitMessage ?? '', llm: 'claude-opus-5-5', authorsText: '@octo',
        }, claudeResult);
        assert.match(body, /Fixed the epic queue/);
        assert.doesNotMatch(body, /watcher timed out/);
    });

    test('a notification sentence that reports a fix in its next clause supersedes the earlier summary', () => {
        const fixed = 'The watcher reported a retry failure, which I fixed in worker.ts.';
        const conversationLog = [
            toolUse('t1'), toolResult('t1'),
            assistantText(SUMMARY),
            notification('Watcher reported a failure'),
            toolUse('t2', 'Looking at the failure.'), toolResult('t2'),
            assistantText(fixed),
        ];
        assert.equal(isRunStatusNote(fixed, { afterNotification: true }), false);
        assert.equal(isRunStatusNote('The watcher reported a retry failure, and I\'ve fixed it in worker.ts.', { afterNotification: true }), false);
        // A clause that reports no change leaves the sentence a notification reply.
        assert.equal(isRunStatusNote('The monitor timed out, and I changed nothing.', { afterNotification: true }), true);

        const { response } = processDockerResult(execution([...conversationLog, result(fixed)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.summary, fixed);
        assert.equal(response.commitMessage?.split('\n')[0], fixed);
        assert.equal(selectRunSummary({ conversationLog }).summary, fixed);
    });

    test('the output-limit continuation prompt is not a notification turn', () => {
        const conversationLog = [
            assistantText(SUMMARY.slice(0, 40)),
            { type: 'user', message: { content: 'Output token limit hit. Resume directly.' } },
            assistantText(SUMMARY.slice(40)),
        ] as Array<{ type?: string; message?: Record<string, unknown> }>;
        assert.equal(selectRunSummary({ resultText: SUMMARY.slice(40), conversationLog }).summary, SUMMARY.slice(40));
    });

    test('status notes are recognised; genuine short summaries and CI mentions are not', () => {
        assert.equal(isRunStatusNote(MONITOR_REPLY), true);
        assert.equal(isRunStatusNote('Verification is complete. Summarizing now.'), true);
        assert.equal(isRunStatusNote('The monitor only expired; it doesn\'t need re-arming.', { afterNotification: true }), true);
        assert.equal(isRunStatusNote('Fixed the typo in README.md.'), false);
        assert.equal(isRunStatusNote('Fixed the flaky retry test; CI on GitHub is still running for the PR.'), false);
        assert.equal(isRunStatusNote(SUMMARY), false);
    });
});

describe('published comment and commit for a run without a summary', () => {
    const baseResult = {
        success: true, model: 'claude-opus-5-5', executionTimeMs: 1000, logs: '', exitCode: 0,
        modelUsed: 'claude-opus-5-5', modifiedFiles: ['a.ts'], commitMessage: null, summary: undefined,
    };

    test('the commit falls back to the request title and the comment says no summary was provided', async () => {
        const claudeResult = agentResultToClaudeResponse({
            ...baseResult,
            conversationLog: [
                toolUse('t1', 'Starting the probe.'),
                toolResult('t1'),
                notification('probe finished'),
                assistantText('Summary: Still running (7 of ~110 suites done). Waiting for the completion notification.'),
            ],
        });
        const commitMessage = buildCommitMessage({
            changesSummary: '', unprocessedComments: [], pullRequestNumber: 12, claudeResult, llm: 'claude-opus-5-5', authorsText: '@octo',
        });
        assert.equal(commitMessage.split('\n')[0], 'feat(ai): Apply follow-up changes from PR comment');

        const body = await buildCompletionComment({ commitHash: 'abcdef1234567' }, [], {
            changesSummary: '', commitMessage, llm: 'claude-opus-5-5', authorsText: '@octo',
        }, claudeResult);
        assert.match(body, new RegExp(`## Summary of Changes\\n\\n${NO_AGENT_SUMMARY_TEXT.replace('.', '\\.')}`));
        assert.doesNotMatch(body, /Still running/);
    });

    test('a long "Summary:" reply to a notification is not taken from the conversation', async () => {
        const reply = `Summary: the watcher timed out. ${'It was the background watcher on the full suite, which had already reported its last batch before the limit, so the timeout says nothing about the code. '.repeat(3)}`.trim();
        const claudeResult = agentResultToClaudeResponse({
            ...baseResult,
            conversationLog: [toolUse('t1', 'Starting the probe.'), toolResult('t1'), notification('Watcher timed out'), assistantText(reply)],
        });
        const body = await buildCompletionComment({ commitHash: 'abcdef1234567' }, [], {
            changesSummary: '', commitMessage: 'feat(ai): Apply follow-up changes from PR comment', llm: 'claude-opus-5-5', authorsText: '@octo',
        }, claudeResult);
        assert.doesNotMatch(body, /watcher timed out/);
        assert.match(body, new RegExp(NO_AGENT_SUMMARY_TEXT.replace('.', '\\.')));
    });

    test('a status-note summary never becomes the commit subject', () => {
        const claudeResult = agentResultToClaudeResponse({ ...baseResult, summary: 'Verification is complete. Summarizing now.' });
        const commitMessage = buildCommitMessage({
            changesSummary: 'Verification is complete. Summarizing now.', unprocessedComments: [], pullRequestNumber: 12, claudeResult, llm: 'claude-opus-5-5', authorsText: '@octo',
        });
        assert.equal(commitMessage.split('\n')[0], 'feat(ai): Apply follow-up changes from PR comment');
    });
});
