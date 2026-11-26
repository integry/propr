import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { ClaudeCodeResponse, UnprocessedComment } from '@propr/core';

// Issue #3808: auto-applied library items an agent runtime cannot apply are
// dropped for the run, and its issue or pull request comment says so.
const { buildCompletionComment } = await import('../src/jobs/prCompletionComment.js');
// prFileUtils' conversion feeds follow-ups; the issue job's copy mirrors it (that module opens Redis on import).
const { agentResultToClaudeResponse } = await import('../src/jobs/prFileUtils.js');
const { generateCompletionComment } = await import('../packages/core/src/utils/github/logFiles.js');
const { extensionRuntimeDropNotice } = await import('../packages/core/src/extensions/extensionRuntimeSupport.js');
const { closeConnection } = await import('@propr/core');

// createLogFiles writes under ./logs/executions; keep that out of the checkout.
const originalCwd = process.cwd();
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-runtime-notice-'));
process.chdir(scratchDir);
after(async () => {
    process.chdir(originalCwd);
    fs.rmSync(scratchDir, { recursive: true, force: true });
    await closeConnection();
});

const notice = extensionRuntimeDropNotice({
    runtime: 'sprites', servers: ['local-files'], skills: [],
    message: 'Agent runtime "sprites" cannot run package (stdio) MCP servers, so this run launched without these auto-applied Extension Library items: MCP server "local-files".',
});

test('the issue completion comment carries the dropped-items note', async () => {
    const response = agentResultToClaudeResponse({
        success: true, logs: '', modifiedFiles: [], modelUsed: 'claude-opus', executionTimeMs: 1000, extensionNotice: notice,
    });
    assert.equal(response.extensionNotice, notice);
    const comment = await generateCompletionComment(response, { number: 1, repoOwner: 'team', repoName: 'repo' });
    assert.match(comment, /> \[!NOTE\]\n> Agent runtime "sprites" cannot run package \(stdio\) MCP servers.*"local-files"\. Run the agent on the docker runtime/);
    const without = await generateCompletionComment({ ...response, extensionNotice: undefined }, { number: 1, repoOwner: 'team', repoName: 'repo' });
    assert.doesNotMatch(without, /Extension Library/);
});

test('the pull request follow-up comment carries the dropped-items note', async () => {
    const comments: UnprocessedComment[] = [{ id: 1, body: 'Please fix', author: 'reviewer', createdAt: new Date().toISOString() }];
    const result: ClaudeCodeResponse = {
        success: true, executionTime: 1000, output: null, logs: '', exitCode: 0, finalResult: null, modifiedFiles: [], commitMessage: null,
        summary: 'Looked into it.', extensionNotice: notice,
    };
    const comment = await buildCompletionComment(null, comments, { changesSummary: 'Looked into it.', commitMessage: '', llm: 'claude-opus', authorsText: '@reviewer' }, result);
    assert.match(comment, /MCP server "local-files"/);
});
