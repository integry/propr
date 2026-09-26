import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    buildMergeNotificationRecap,
    buildReviewNotificationRecap,
    buildWorkNotificationRecap,
    compactNotificationRecap,
} from '../src/jobs/notificationRecap.js';

const REVIEW = [
    '## Overall Evaluation',
    'Two changes are required before merge.',
    '',
    '## Actionable Findings',
    '### F1: Preserve terminal state',
    '- **violatedRequirement:** Terminal states cannot be resurrected',
    '- **evidence:** src/worker.ts:128 — the new branch accepts the transition',
    '- **introducedByPR:** true — the changed handler added the branch',
    '- **requiredForMerge:** true',
    '- **minimumCorrection:** reject transitions from terminal states',
    '### F2: Keep the receipt atomic',
    '- **violatedRequirement:** Receipt updates must be atomic',
    '- **evidence:** src/inbox.ts:44 — the update runs outside the transaction',
    '- **introducedByPR:** true — the changed service moved the update',
    '- **requiredForMerge:** true',
    '- **minimumCorrection:** move the update into the transaction',
    '',
    '## Suggestions and Follow-ups',
    'No suggestions.',
    '',
    '## Score',
    'Score: 6/10',
].join('\n');

describe('notification recaps', () => {
    test('turns Markdown work summaries into compact plain text', () => {
        assert.equal(
            compactNotificationRecap('## Summary of Changes\n\n- Added swipe dismissal\n- Added **Undo** support'),
            'Added swipe dismissal · Added Undo support',
        );
        assert.equal(
            compactNotificationRecap('Updated `notification_user_states` in __init_db.ts__ and _src/snake_case_file.ts_ ~~twice~~ *once*'),
            'Updated notification_user_states in init_db.ts and src/snake_case_file.ts twice once',
        );
        assert.equal(
            buildWorkNotificationRecap('', { commandMode: 'fix', filesChanged: 2 }),
            'Applied the requested review fixes across 2 files.',
        );
    });

    test('includes the review score, issue count, and issue titles', () => {
        assert.equal(buildReviewNotificationRecap([{
            analysisResult: { success: true, response: REVIEW },
            findingCount: 2,
        }]), 'Score 6/10 · 2 issues found: Preserve terminal state; Keep the receipt atomic');
    });

    test('describes clean and conflict-resolving merge outcomes', () => {
        assert.equal(buildMergeNotificationRecap({
            baseBranch: 'main', headBranch: 'feature/inbox', conflictedFiles: [],
        }), 'Merged main into feature/inbox cleanly.');
        assert.match(buildMergeNotificationRecap({
            baseBranch: 'main', headBranch: 'feature/inbox',
            conflictedFiles: ['Inbox.tsx'], summary: 'Kept both accessibility handlers.',
        }), /resolved conflicts in 1 file.*Kept both accessibility handlers/);
    });
});
