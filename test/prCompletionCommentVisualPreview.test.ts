import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection, VISUAL_PREVIEW_SLOT } from '@propr/core';
import type { ClaudeCodeResponse, UnprocessedComment } from '@propr/core';
import { buildCompletionComment } from '../src/jobs/prCompletionComment.js';
import { buildCommitMessage } from '../src/jobs/prCommentJobUtils.js';

after(async () => {
    await closeConnection();
});

test('keeps the visual preview slot in a preview-only follow-up without a commit', async () => {
    const comments: UnprocessedComment[] = [{
        id: 5527365804,
        body: 'Try showing the preview again',
        author: 'integry',
        createdAt: new Date().toISOString(),
    }];
    const localPreviewPath = '/tmp/git-processor/worktrees/integry/propr/pr-2091/.propr/previews/goal-details-delete-desktop.png';
    const localManifestPath = '/tmp/git-processor/worktrees/integry/propr/pr-2091/.propr/previews/manifest.json';
    const summary = [
        'Preview capture succeeded using Chromium.',
        `- [View goal details preview](<${localPreviewPath}>)`,
        `- [Preview manifest](<${localManifestPath}>)`,
        '- UI production build passed.',
    ].join('\n');
    const result: ClaudeCodeResponse = {
        success: true,
        executionTime: 1000,
        output: null,
        logs: '',
        exitCode: 0,
        finalResult: null,
        modifiedFiles: [],
        commitMessage: null,
        summary,
    };

    const comment = await buildCompletionComment(null, comments, {
        changesSummary: summary,
        commitMessage: '',
        llm: 'gpt-5.6-sol',
        authorsText: '@integry',
        visualPreviewSection: VISUAL_PREVIEW_SLOT,
    }, result);

    assert.match(comment, /Preview capture succeeded using Chromium/);
    assert.match(comment, /UI production build passed/);
    assert.match(comment, /Visual preview results are included below/);
    assert.match(comment, new RegExp(VISUAL_PREVIEW_SLOT));
    assert.doesNotMatch(comment, /\.propr\/previews\//);
});

test('omits agent-side commit housekeeping from a committed follow-up report', async () => {
    const comments: UnprocessedComment[] = [{
        id: 5700144815,
        body: '/fix',
        author: 'integry',
        createdAt: new Date().toISOString(),
    }];
    const summary = [
        'Implemented F2–F5 only.',
        '',
        'Validation: 61 focused tests passed.',
        'No commits or preview files created.',
    ].join('\n');
    const result: ClaudeCodeResponse = {
        success: true,
        executionTime: 1000,
        output: null,
        logs: '',
        exitCode: 0,
        finalResult: null,
        modifiedFiles: ['src/example.ts'],
        commitMessage: null,
        summary,
    };

    const commitMessage = buildCommitMessage({
        changesSummary: summary,
        unprocessedComments: comments,
        pullRequestNumber: 2435,
        claudeResult: result,
        llm: 'gpt-6-astra',
        authorsText: '@integry',
    });
    const comment = await buildCompletionComment({ commitHash: '8ce976cca544' }, comments, {
        changesSummary: summary,
        commitMessage,
        llm: 'gpt-6-astra',
        authorsText: '@integry',
    }, result);

    assert.match(comment, /Applied the requested follow-up changes.*8ce976c/);
    assert.match(comment, /Implemented F2–F5 only/);
    assert.match(comment, /61 focused tests passed/);
    assert.doesNotMatch(commitMessage, /No commits|uncommitted/i);
    assert.doesNotMatch(comment, /No commits|uncommitted/i);
});
