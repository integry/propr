import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    buildMergeNotificationRecap,
    buildReviewNotificationRecap,
    buildReviewNotificationSummary,
    buildWorkNotificationRecap,
    compactNotificationRecap,
    fullNotificationSummary,
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

    test('keeps the full summary for the Inbox detail pane, dropping only hidden comments', () => {
        const summary = '## Summary of Changes\n\n<!-- marker -->\n- Fixed the **Inbox** detail pane\n- Added tests';
        assert.equal(fullNotificationSummary(summary), '## Summary of Changes\n\n\n- Fixed the **Inbox** detail pane\n- Added tests');
        assert.equal(fullNotificationSummary('  <!-- only -->  '), undefined);
        assert.equal(fullNotificationSummary('Done<!<!---->-- hidden -->'), 'Done');
        assert.equal(fullNotificationSummary('Done\n<!-- unclosed\nhidden'), 'Done');
        assert.equal(fullNotificationSummary(42), undefined);
    });

    test('keeps a summary of any length whole', () => {
        const long = `${'word '.repeat(10_000)}last finding`;
        assert.equal(fullNotificationSummary(long), long);
        const review = (label: string) => `## Review ${label}\n\n${'finding '.repeat(3_000)}end of ${label}`;
        assert.equal(
            buildReviewNotificationSummary([
                { analysisResult: { success: true }, commentBody: review('A') },
                { analysisResult: { success: true }, commentBody: review('B') },
            ]),
            `${review('A')}\n\n${review('B')}`,
        );
    });

    test('keeps comment syntax that code spans and fenced blocks show', () => {
        const inline = 'Fixed handling of `<!--` in the parser.\n\n## Testing\n\n- Parser tests pass <!-- hidden -->';
        assert.equal(fullNotificationSummary(inline), 'Fixed handling of `<!--` in the parser.\n\n## Testing\n\n- Parser tests pass');
        assert.equal(fullNotificationSummary('Matches ``a `<!--` b`` only. Then <!-- x -->more.'), 'Matches ``a `<!--` b`` only. Then more.');
        const fenced = 'Example:\n\n```html\n<!-- kept -->\n<!-- unclosed\n```\n\nAfter the fence <!-- hidden -->stays.';
        assert.equal(fullNotificationSummary(fenced), 'Example:\n\n```html\n<!-- kept -->\n<!-- unclosed\n```\n\nAfter the fence stays.');
        assert.equal(fullNotificationSummary('~~~\n<!--\n~~~\nDone'), '~~~\n<!--\n~~~\nDone');
        assert.equal(fullNotificationSummary('An inline <!-- opener with no close stays.'), 'An inline <!-- opener with no close stays.');
        assert.equal(fullNotificationSummary('Escaped \\`<!-- x -->` tick'), 'Escaped \\`` tick');
        assert.equal(compactNotificationRecap('Fixed `<!--` parsing. Tests pass.'), 'Fixed <!-- parsing. Tests pass.');
    });

    test('keeps comment syntax that indented code blocks show', () => {
        const unclosed = 'Parser example:\n\n    <!-- example\n\n## Testing\n\nAll tests passed.';
        assert.equal(fullNotificationSummary(unclosed), unclosed);
        const closed = '    <!-- kept -->\n\n\t<!-- tab -->\n\nAfter the code <!-- hidden -->stays.';
        assert.equal(fullNotificationSummary(closed), '    <!-- kept -->\n\n\t<!-- tab -->\n\nAfter the code stays.');
        assert.equal(fullNotificationSummary('## Example\n    <!-- kept -->\nDone <!-- x -->'), '## Example\n    <!-- kept -->\nDone');
        // Indentation that continues a paragraph is not code, and does not open a hidden block.
        assert.equal(fullNotificationSummary('Paragraph\n    <!-- literal\n\nDone'), 'Paragraph\n    <!-- literal\n\nDone');
        assert.equal(fullNotificationSummary('Paragraph\n    <!-- x -->more'), 'Paragraph\n    more');
        assert.equal(fullNotificationSummary('Done\n   <!-- unclosed\nhidden'), 'Done');
    });

    test('keeps comment syntax that code inside blockquotes and list items shows', () => {
        const quotedFence = 'See:\n\n> ~~~html\n> <!-- required marker -->\n> ~~~\n\nAfter <!-- hidden -->stays.';
        assert.equal(fullNotificationSummary(quotedFence), 'See:\n\n> ~~~html\n> <!-- required marker -->\n> ~~~\n\nAfter stays.');
        const quotedIndented = 'See:\n\n>     <!-- required marker -->\n> Quoted <!-- hidden -->text.';
        assert.equal(fullNotificationSummary(quotedIndented), 'See:\n\n>     <!-- required marker -->\n> Quoted text.');
        assert.equal(fullNotificationSummary('> > ```\n> > <!-- kept\n> > ```\n> <!-- x -->Done'), '> > ```\n> > <!-- kept\n> > ```\n> Done');
        assert.equal(fullNotificationSummary('- ```html\n  <!-- kept -->\n  ```\n- Item <!-- x -->two'), '- ```html\n  <!-- kept -->\n  ```\n- Item two');
        assert.equal(fullNotificationSummary('1. Step\n\n   > ```\n   > <!-- kept -->\n   > ```'), '1. Step\n\n   > ```\n   > <!-- kept -->\n   > ```');
        // Leaving the blockquote closes its code block, so later comments stay hidden.
        assert.equal(fullNotificationSummary('> ```\n> <!-- kept -->\n\nOutside <!-- x -->the quote'), '> ```\n> <!-- kept -->\n\nOutside the quote');
        assert.equal(fullNotificationSummary('>     <!-- kept -->\nLazy <!-- x -->line'), '>     <!-- kept -->\nLazy line');
        // Indentation that continues a quoted paragraph is not code.
        assert.equal(fullNotificationSummary('> Paragraph\n>     <!-- x -->more'), '> Paragraph\n>     more');
    });

    test('keeps every posted review in full, without its details footer', () => {
        const body = (label: string) => `## 🔍 AI Code Review — ${label}\n\n## Overall Evaluation\n\nLooks right.\n\n---\n### 🤖 Review Details\n\n* **Model:** Opus`;
        assert.equal(buildReviewNotificationSummary([
            { analysisResult: { success: true }, commentBody: body('Claude') },
            { analysisResult: { success: false }, commentBody: 'error' },
            { analysisResult: { success: true }, commentBody: body('GPT') },
        ]), `## 🔍 AI Code Review — Claude\n\n## Overall Evaluation\n\nLooks right.\n\n## 🔍 AI Code Review — GPT\n\n## Overall Evaluation\n\nLooks right.`);
        assert.equal(buildReviewNotificationSummary([{ analysisResult: { success: false } }]), undefined);
    });
});
