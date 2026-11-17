import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateCompletionComment, generateCompletionCommentParts } from '../packages/core/src/utils/github/logFiles.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

const originalCwd = process.cwd();
let workDir = '';

before(() => {
    // Log files are still written (for the task page); keep them out of the repository.
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-completion-report-'));
    process.chdir(workDir);
});

after(async () => {
    process.chdir(originalCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
    await closeConnection();
});

const issueRef = { number: 3582, repoOwner: 'integry', repoName: 'propr' };

function agentResult(overrides: Record<string, unknown> = {}) {
    return {
        success: true,
        executionTime: 65_000,
        summary: 'Implemented the change.',
        model: 'claude-opus-5-5',
        conversationLog: [
            { type: 'assistant', message: { content: [{ type: 'tool_use' }] } },
            { type: 'assistant', message: { content: [{ text: 'Implemented the change.' }] } },
        ],
        rawOutput: 'raw stream',
        ...overrides,
    };
}

test('a PR body links the task page instead of log paths and conversation excerpts (#3622 point 3)', async () => {
    const taskUrl = 'https://propr.example/tasks/integry-propr-3582-claude-opus-5-5-abc';
    const parts = await generateCompletionCommentParts(agentResult(), issueRef, { taskUrl });
    const report = `${parts.run}${parts.summary}${parts.logs}`;

    assert.equal(parts.logs, `[View task details and logs](${taskUrl})\n\n`);
    assert.doesNotMatch(report, /Detailed Logs|Log files stored at|Latest Conversation Messages|content unavailable|\/logs\/executions\/|Session:/);
    // The summary appears once, not again as a conversation excerpt.
    assert.equal(report.split('Implemented the change.').length - 1, 1);
});

test('without a task URL the report carries no log section at all', async () => {
    const comment = await generateCompletionComment(agentResult(), issueRef, { publishedAs: 'issue_comment' });
    assert.doesNotMatch(comment, /Detailed Logs|Log files stored at|Latest Conversation Messages/);
});

test('a placeholder model such as <synthetic> is not shown as the LLM model (#3529)', async () => {
    const comment = await generateCompletionComment(agentResult({ success: false, model: '<synthetic>' }), issueRef, { publishedAs: 'issue_comment' });
    assert.doesNotMatch(comment, /LLM Model|<synthetic>/);
    const named = await generateCompletionComment(agentResult({ model: 'claude-opus-5-5' }), issueRef);
    assert.match(named, /LLM Model:/);
});
