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

    test('ordinary runs keep the reported result unchanged', () => {
        const short = 'Fixed the typo in README.md.';
        const { response } = processDockerResult(execution([toolUse('t1'), toolResult('t1'), assistantText(short), result(short)]), 'prompt', 'claude-opus-5-5', 1);
        assert.equal(response.summary, short);
        assert.equal(response.success, true);
        assert.equal(response.terminationReason, undefined);
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
