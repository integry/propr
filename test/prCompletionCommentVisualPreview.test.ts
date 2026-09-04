import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection, VISUAL_PREVIEW_SLOT } from '@propr/core';
import type { ClaudeCodeResponse, UnprocessedComment } from '@propr/core';
import { buildCompletionComment } from '../src/jobs/prCompletionComment.js';

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
