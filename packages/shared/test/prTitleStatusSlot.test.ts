import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    hasStatusSlot, mergeCommitTitleFields, readStatusSlot, renderStatusSlot, stripStatusSlot, withStatusSlot,
} from '../src/prTitleStatusSlot.js';

const TITLE = '[3475 by Claude Opus 5.5] Let an automation run when a plan issue is blocked';

test('renders one slot per persistent state, with the score beside ⚠️ and ✅', () => {
    assert.equal(renderStatusSlot({ state: 'working', score: 8 }), '🔨');
    assert.equal(renderStatusSlot({ state: 'needs_attention', score: 6 }), '⚠️⑥');
    assert.equal(renderStatusSlot({ state: 'ready', score: 8 }), '✅⑧');
    assert.equal(renderStatusSlot({ state: 'ready', score: 10 }), '✅⑩');
    assert.equal(renderStatusSlot({ state: 'ready', score: 1 }), '✅①');
    assert.equal(renderStatusSlot({ state: 'ready', score: null }), '✅');
    assert.equal(renderStatusSlot({ state: 'needs_attention', score: 0 }), '⚠️', 'no circled digit outside 1 to 10');
    assert.equal(renderStatusSlot({ state: 'ready', score: 7.6 }), '✅⑧');
    assert.equal(renderStatusSlot(null), null);
});

test('sets, replaces and removes only the slot', () => {
    assert.equal(withStatusSlot(TITLE, { state: 'working' }), `🔨 ${TITLE}`);
    assert.equal(withStatusSlot(`🔨 ${TITLE}`, { state: 'ready', score: 8 }), `✅⑧ ${TITLE}`);
    assert.equal(withStatusSlot(`✅⑧ ${TITLE}`, { state: 'needs_attention', score: 6 }), `⚠️⑥ ${TITLE}`);
    assert.equal(withStatusSlot(`⚠️⑥ ${TITLE}`, null), TITLE);
    assert.equal(withStatusSlot(`✅⑧ ${TITLE}`, { state: 'working' }), `🔨 ${TITLE}`);
    assert.equal(withStatusSlot('', { state: 'working' }), '🔨 ');
});

test('accepts ⚠ with and without the variation selector', () => {
    assert.equal(readStatusSlot(`⚠️⑥ ${TITLE}`), '⚠️⑥');
    assert.equal(readStatusSlot(`⚠⑥ ${TITLE}`), '⚠⑥');
    assert.equal(stripStatusSlot(`⚠ ${TITLE}`), TITLE);
    assert.equal(withStatusSlot(`⚠⑥ ${TITLE}`, { state: 'ready', score: 9 }), `✅⑨ ${TITLE}`);
});

test('recognises only a strict slot anchored at the start', () => {
    for (const title of [TITLE, `x 🔨 ${TITLE}`, `🔨${TITLE}`, `🔨⑧ ${TITLE}`, `⑧ ${TITLE}`, ` 🔨 ${TITLE}`, `🔧 ${TITLE}`]) {
        assert.equal(hasStatusSlot(title), false, title);
        assert.equal(stripStatusSlot(title), title, title);
    }
    assert.equal(stripStatusSlot(`✅ ✅ done`), '✅ done', 'only the leading slot is removed');
    assert.equal(stripStatusSlot(`🔨  ${TITLE}`), ` ${TITLE}`, 'one space belongs to the slot, the rest to the title');
    assert.equal(stripStatusSlot(null), null);
});

test('leaves the title unchanged when the slot would exceed the 256 character limit', () => {
    const long = 'a'.repeat(254);
    assert.equal(withStatusSlot(long, { state: 'working' }), long);
    assert.equal(withStatusSlot(`🔨 ${'b'.repeat(250)}`, { state: 'ready', score: 8 }), `✅⑧ ${'b'.repeat(250)}`);
    const exact = 'c'.repeat(253);
    assert.equal(withStatusSlot(exact, { state: 'working' }).length, 256);
});

test('merge commit titles carry no slot', () => {
    assert.deepEqual(mergeCommitTitleFields({ number: 3510, title: `✅⑧ ${TITLE}` }, 'squash'), { commit_title: `${TITLE} (#3510)` });
    assert.deepEqual(mergeCommitTitleFields({ number: 3510, title: TITLE }, 'squash'), { commit_title: `${TITLE} (#3510)` });
    assert.deepEqual(mergeCommitTitleFields({ number: 7, title: `🔨 ${TITLE}`, headLabel: 'integry:feature' }, 'merge'),
        { commit_title: 'Merge pull request #7 from integry/feature', commit_message: TITLE });
    assert.deepEqual(mergeCommitTitleFields({ number: 7, title: `🔨 ${TITLE}` }, 'rebase'), {});
    assert.deepEqual(mergeCommitTitleFields({ number: 7 }, 'squash'), {}, 'no title read: GitHub\'s default');
});

test('an epic slot carries merged/total after the emoji and no score', () => {
    const EPIC = '[Epic] Scheduler primitives';
    assert.equal(renderStatusSlot({ state: 'working', progress: { merged: 3, total: 5 } }), '🔨 3/5');
    assert.equal(renderStatusSlot({ state: 'ready', score: 8, progress: { merged: 5, total: 5 } }), '✅ 5/5', 'no score beside an epic count');
    assert.equal(renderStatusSlot({ state: 'needs_attention', progress: { merged: 0, total: 0 } }), '⚠️', 'no count for an epic without issues');
    assert.equal(withStatusSlot(EPIC, { state: 'working', progress: { merged: 0, total: 5 } }), `🔨 0/5 ${EPIC}`);
    assert.equal(withStatusSlot(`🔨 3/5 ${EPIC}`, { state: 'needs_attention', progress: { merged: 4, total: 5 } }), `⚠️ 4/5 ${EPIC}`);
    assert.equal(readStatusSlot(`⚠️ 4/5 ${EPIC}`), '⚠️ 4/5');
    assert.equal(readStatusSlot(`⚠ 4/5 ${EPIC}`), '⚠ 4/5');
    assert.equal(stripStatusSlot(`✅ 5/5 ${EPIC}`), EPIC);
    assert.equal(stripStatusSlot(`🔨 3/5 ${EPIC}`), EPIC);
    assert.equal(withStatusSlot(`✅ 5/5 ${EPIC}`, null), EPIC);
    for (const title of [`🔨3/5 ${EPIC}`, `3/5 ${EPIC}`]) assert.equal(stripStatusSlot(title), title, title);
    assert.equal(stripStatusSlot(`🔨 3/ ${EPIC}`), `3/ ${EPIC}`, "a malformed count is the title's, not the slot's");
    assert.deepEqual(mergeCommitTitleFields({ number: 9, title: `✅ 5/5 ${EPIC}` }, 'squash'), { commit_title: `${EPIC} (#9)` });
});
