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

test('names the findings and the suggestions a fix run addressed', async () => {
    const comments: UnprocessedComment[] = [{
        id: 5700144816,
        body: '/fix F20 S3 S5',
        author: 'integry',
        createdAt: new Date().toISOString(),
    }];
    const result: ClaudeCodeResponse = {
        success: true,
        executionTime: 1000,
        output: null,
        logs: '',
        exitCode: 0,
        finalResult: null,
        modifiedFiles: ['src/config.ts'],
        commitMessage: null,
        summary: 'Rejected stale revisions and extracted the retry helper.',
    };

    const comment = await buildCompletionComment({ commitHash: 'abcdef1234567890' }, comments, {
        changesSummary: result.summary!,
        commitMessage: 'fix: reject stale revisions',
        llm: 'claude-opus-5',
        authorsText: '@integry',
        consumedReviewCommentIds: [960],
        addressedFeedback: { findingIds: ['F20'], suggestionIds: ['S3', 'S5'] },
    }, result);

    // Blocking and optional work stay visually separate in the receipt.
    assert.match(comment, /> Addressed finding F20 · suggestions S3, S5/);
});

test('omits the addressed line when a run addressed no review record', async () => {
    const comments: UnprocessedComment[] = [{
        id: 5700144817,
        body: 'Please tidy the helper',
        author: 'integry',
        createdAt: new Date().toISOString(),
    }];
    const result: ClaudeCodeResponse = {
        success: true,
        executionTime: 1000,
        output: null,
        logs: '',
        exitCode: 0,
        finalResult: null,
        modifiedFiles: ['src/config.ts'],
        commitMessage: null,
        summary: 'Tidied the helper.',
    };

    const comment = await buildCompletionComment({ commitHash: 'abcdef1234567890' }, comments, {
        changesSummary: result.summary!,
        commitMessage: 'chore: tidy the helper',
        llm: 'claude-opus-5',
        authorsText: '@integry',
        addressedFeedback: { findingIds: [], suggestionIds: [] },
    }, result);

    assert.doesNotMatch(comment, /> Addressed/);
});
