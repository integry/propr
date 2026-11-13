import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateClaudePrompt } from '../src/claude/prompts/promptGenerator.js';
import { buildReviewDigest } from '../src/workflow/reviewDigest.js';
import { renderReviewDigest } from '../src/workflow/reviewDigestMarkdown.js';

const issueRef = { number: 7, repoOwner: 'acme', repoName: 'app' };
const body = '## Goal\n\nPad values.\n\n## Acceptance criteria\n\n- [ ] Values are padded\n- [ ] Usage is documented\n\n## Out of scope\n\n- A CLI\n';

test('the implementation prompt lists the criteria with stable ids and asks for a per-criterion statement', () => {
    const prompt = generateClaudePrompt({ issueRef, issueDetails: { title: 'Pad', body } });
    assert.ok(prompt.includes('**ACCEPTANCE CRITERIA (account for each one):**\n- AC1: Values are padded\n- AC2: Usage is documented\n'), prompt);
    assert.ok(!prompt.includes('AC3'));
    assert.match(prompt, /End your final summary with an `Acceptance criteria` list that has exactly one line per criterion/);
    assert.match(prompt, /each in the form `- <id>: <status> — <evidence>`\. The status is `met`, `not met` or `not applicable`\./);
    // The section follows the issue details, before the step list.
    assert.ok(prompt.indexOf('ACCEPTANCE CRITERIA') > prompt.indexOf('**ISSUE DETAILS'));
    assert.ok(prompt.indexOf('ACCEPTANCE CRITERIA') < prompt.indexOf('**YOUR FOCUS: IMPLEMENTATION ONLY**'));
});

test('without an Acceptance criteria heading the prompt is unchanged', () => {
    const plain = 'Pad values.\n\nAcceptance criteria: values are padded.';
    const prompt = generateClaudePrompt({ issueRef, issueDetails: { title: 'Pad', body: plain } });
    assert.ok(!prompt.includes('ACCEPTANCE CRITERIA'));
    assert.ok(!generateClaudePrompt({ issueRef }).includes('ACCEPTANCE CRITERIA'));
});

test('the digest renders the checklist before the risk tiers; criteria and evidence are code spans', () => {
    const digest = buildReviewDigest([{ path: 'src/pad.ts', linesAdded: 3, linesRemoved: 0 }], null, {}, {
        criteria: [{ id: 'AC1', text: 'Values are padded' }, { id: 'AC2', text: 'Usage is `documented` @team' }, { id: 'AC3', text: 'No CLI' }],
        agentReport: 'Done.\n\n- AC1: met — `src/pad.ts`, `test/pad.test.ts`\n- AC3: not met: left for later',
    });
    assert.deepEqual(digest?.acceptanceCriteria?.map(result => result.status), ['met', 'not_addressed', 'not_met']);
    assert.equal(renderReviewDigest(digest).split('**Risk-tiered paths**')[0], [
        '### Review digest',
        '',
        '**Acceptance criteria** (1 of 3 met, as stated by the agent)',
        '',
        '- ✅ **AC1** (met): `Values are padded` — `` `src/pad.ts`, `test/pad.test.ts` ``',
        '- ⚠️ **AC2** (not addressed): ``Usage is `documented` @team``',
        '- ❌ **AC3** (not met): `No CLI` — `left for later`',
        '',
        '',
    ].join('\n'));
});

test('a digest without criteria has no checklist and keeps no criteria field', () => {
    const digest = buildReviewDigest([{ path: 'src/pad.ts', linesAdded: 3, linesRemoved: 0 }], null, {}, { criteria: [], agentReport: '- AC1: met' });
    assert.equal(digest && 'acceptanceCriteria' in digest, false);
    assert.ok(!renderReviewDigest(digest).includes('Acceptance criteria'));
});
