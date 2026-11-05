import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS = '@propr';
const { pullRequestJobAllowed } = await import('../src/jobs/prCommentLabelGate.js');

after(async () => {
    // The fallback label lookup opens core's database connection.
    const { closeConnection } = await import('@propr/core');
    await closeConnection();
});

const PRIMARY = ['AI', 'gitfix'];
const comment = (body: string) => ({ id: 1, body, author: 'integry', type: 'issue' as const });
const allowed = (labels: string[], data: Record<string, unknown>, body = 'Please tidy this up.') =>
    pullRequestJobAllowed(labels.map(name => ({ name })), PRIMARY, { data, comments: [comment(body)], correlationId: 'c' });

test('a processing label opts the pull request in for plain follow-ups', async () => {
    assert.equal(await allowed(['AI'], { commandMode: 'default' }), true);
});

test('a plain follow-up on an unlabelled pull request is still skipped', async () => {
    assert.equal(await allowed([], { commandMode: 'default' }), false);
    assert.equal(await allowed(['ultrafix'], {}), false, 'the ultrafix circuit-breaker label is not a processing label');
});

test('explicit commands run on an unlabelled pull request, such as a running goal\'s draft PR', async () => {
    for (const commandMode of ['review', 'fix', 'ultrafix']) {
        assert.equal(await allowed(['ultrafix'], { commandMode }), true, commandMode);
    }
    // Later Ultrafix cycles carry their loop metadata.
    assert.equal(await allowed(['ultrafix'], { commandMode: 'default', ultrafixMeta: { goal: 8 } }), true);
});

test('a trigger keyword runs on an unlabelled pull request, as intake accepted it', async () => {
    assert.equal(await allowed([], { commandMode: 'default' }, '@propr please fix the typo'), true);
});
