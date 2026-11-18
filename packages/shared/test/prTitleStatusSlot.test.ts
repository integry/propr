import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    hasStatusSlot, mergeCommitTitleFields, readStatusSlot, renderStatusSlot, stripStatusSlot, withStatusSlot,
} from '../src/prTitleStatusSlot.js';

const TITLE = '[3475 by Claude Opus 5.5] Let an automation run when a plan issue is blocked';

test('renders one slot per persistent state, with the score beside ⚠️ and ✅', () => {
    assert.equal(renderStatusSlot({ state: 'working', score: 8 }), '🔨');
    assert.equal(renderStatusSlot({ state: 'needs_attention', score: 6 }), '⚠️❻');
    assert.equal(renderStatusSlot({ state: 'ready', score: 8 }), '✅❽');
    assert.equal(renderStatusSlot({ state: 'ready', score: 10 }), '✅❿');
    assert.equal(renderStatusSlot({ state: 'ready', score: 1 }), '✅❶');
    assert.equal(renderStatusSlot({ state: 'ready', score: null }), '✅');
    assert.equal(renderStatusSlot({ state: 'needs_attention', score: 0 }), '⚠️', 'no circled digit outside 1 to 10');
    assert.equal(renderStatusSlot({ state: 'ready', score: 7.6 }), '✅❽');
    assert.equal(renderStatusSlot(null), null);
});

test('sets, replaces and removes only the slot', () => {
    assert.equal(withStatusSlot(TITLE, { state: 'working' }), `🔨 ${TITLE}`);
    assert.equal(withStatusSlot(`🔨 ${TITLE}`, { state: 'ready', score: 8 }), `✅❽ ${TITLE}`);
    assert.equal(withStatusSlot(`✅❽ ${TITLE}`, { state: 'needs_attention', score: 6 }), `⚠️❻ ${TITLE}`);
    assert.equal(withStatusSlot(`⚠️❻ ${TITLE}`, null), TITLE);
    assert.equal(withStatusSlot(`✅❽ ${TITLE}`, { state: 'working' }), `🔨 ${TITLE}`);
    assert.equal(withStatusSlot('', { state: 'working' }), '🔨 ');
});

test('accepts ⚠ with and without the variation selector', () => {
    assert.equal(readStatusSlot(`⚠️❻ ${TITLE}`), '⚠️❻');
    assert.equal(readStatusSlot(`⚠❻ ${TITLE}`), '⚠❻');
    assert.equal(stripStatusSlot(`⚠ ${TITLE}`), TITLE);
    assert.equal(withStatusSlot(`⚠❻ ${TITLE}`, { state: 'ready', score: 9 }), `✅❾ ${TITLE}`);
});

test('writes the score as a Dingbats negative circled digit ❶–❿ (#3658)', () => {
    for (let score = 1; score <= 10; score += 1) {
        const slot = renderStatusSlot({ state: 'ready', score }) as string;
        assert.equal(slot.codePointAt(1), 0x2776 + score - 1, `score ${score}`);
        assert.equal([...slot].length, 2, `one score character for ${score}`);
    }
    assert.equal(renderStatusSlot({ state: 'ready', score: 1 }), '✅\u2776');
    assert.equal(renderStatusSlot({ state: 'ready', score: 10 }), '✅\u277F');
});

test('reads the older ①–⑩ (#3576) and ➀–➉ slots and rewrites them with ❶–❿, never leaving two score characters', () => {
    for (const first of [0x2460, 0x2780, 0x2776]) {
        for (let score = 1; score <= 10; score += 1) {
            const digit = String.fromCodePoint(first + score - 1);
            const next = String.fromCodePoint(0x2776 + score - 1);
            for (const emoji of ['⚠️', '⚠', '✅']) {
                assert.equal(readStatusSlot(`${emoji}${digit} ${TITLE}`), `${emoji}${digit}`);
                assert.equal(stripStatusSlot(`${emoji}${digit} ${TITLE}`), TITLE);
            }
            assert.equal(withStatusSlot(`⚠️${digit} ${TITLE}`, { state: 'ready', score }), `✅${next} ${TITLE}`);
            assert.equal(withStatusSlot(`✅${digit} ${TITLE}`, { state: 'needs_attention', score }), `⚠️${next} ${TITLE}`);
            assert.equal(withStatusSlot(`✅${digit} ${TITLE}`, { state: 'working' }), `🔨 ${TITLE}`);
            assert.equal(withStatusSlot(`✅${digit} ${TITLE}`, null), TITLE);
            assert.equal(hasStatusSlot(`🔨${digit} ${TITLE}`), false, 'no score beside 🔨 in any form');
            assert.equal(hasStatusSlot(`${digit} ${TITLE}`), false, 'no score without its emoji');
        }
    }
    // Two score characters are not a slot, so the title is never stacked further.
    assert.equal(hasStatusSlot(`✅❽⑧ ${TITLE}`), false);
    // Epic titles carry no score and are unchanged.
    const EPIC = '[Epic] Plugin system';
    assert.equal(withStatusSlot(`✅ 7/7 ${EPIC}`, { state: 'ready', score: 8, progress: { merged: 7, total: 7 } }), `✅ 7/7 ${EPIC}`);
    assert.equal(withStatusSlot(`◕ 6/7 ${EPIC}`, { state: 'working', progress: { merged: 6, total: 7 } }), `◕ 6/7 ${EPIC}`);
    assert.equal(withStatusSlot(`◑ 5/7 ${EPIC}`, { state: 'working', progress: { merged: 5, total: 7 } }), `◑ 5/7 ${EPIC}`);
    assert.equal(stripStatusSlot(`◕ 6/7 ${EPIC}`), EPIC);
});

test('recognises only a strict slot anchored at the start', () => {
    for (const title of [TITLE, `x 🔨 ${TITLE}`, `🔨${TITLE}`, `🔨❽ ${TITLE}`, `❽ ${TITLE}`, ` 🔨 ${TITLE}`, `🔧 ${TITLE}`]) {
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
    assert.equal(withStatusSlot(`🔨 ${'b'.repeat(250)}`, { state: 'ready', score: 8 }), `✅❽ ${'b'.repeat(250)}`);
    const exact = 'c'.repeat(253);
    assert.equal(withStatusSlot(exact, { state: 'working' }).length, 256);
});

test('merge commit titles carry no slot', () => {
    assert.deepEqual(mergeCommitTitleFields({ number: 3510, title: `✅❽ ${TITLE}` }, 'squash'), { commit_title: `${TITLE} (#3510)` });
    assert.deepEqual(mergeCommitTitleFields({ number: 3510, title: TITLE }, 'squash'), { commit_title: `${TITLE} (#3510)` });
    assert.deepEqual(mergeCommitTitleFields({ number: 7, title: `🔨 ${TITLE}`, headLabel: 'integry:feature' }, 'merge'),
        { commit_title: 'Merge pull request #7 from integry/feature', commit_message: TITLE });
    assert.deepEqual(mergeCommitTitleFields({ number: 7, title: `🔨 ${TITLE}` }, 'rebase'), {});
    assert.deepEqual(mergeCommitTitleFields({ number: 7 }, 'squash'), {}, 'no title read: GitHub\'s default');
});

test('an epic slot carries merged/total after the emoji and no score', () => {
    const EPIC = '[Epic] Scheduler primitives';
    assert.equal(renderStatusSlot({ state: 'working', progress: { merged: 3, total: 5 } }), '◑ 3/5');
    assert.equal(renderStatusSlot({ state: 'ready', score: 8, progress: { merged: 5, total: 5 } }), '✅ 5/5', 'no score beside an epic count');
    assert.equal(renderStatusSlot({ state: 'needs_attention', progress: { merged: 0, total: 0 } }), '⚠️', 'no count for an epic without issues');
    assert.equal(withStatusSlot(EPIC, { state: 'working', progress: { merged: 0, total: 5 } }), `○ 0/5 ${EPIC}`);
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

test('a working epic shows a pie circle chosen from merged/total instead of 🔨', () => {
    const working = (merged: number, total: number) => renderStatusSlot({ state: 'working', progress: { merged, total } });
    for (const [merged, total, slot] of [
        [0, 21, '○ 0/21'], [1, 21, '◔ 1/21'], [10, 21, '◔ 10/21'], [11, 21, '◑ 11/21'],
        [2, 4, '◑ 2/4'], [15, 21, '◑ 15/21'], [16, 21, '◕ 16/21'], [3, 4, '◕ 3/4'], [2, 4 * 1, '◑ 2/4'],
        [17, 21, '◕ 17/21'], [20, 21, '◕ 20/21'], [1, 2, '◑ 1/2'], [1, 1, '◕ 1/1'],
    ] as const) assert.equal(working(merged, total), slot, `${merged}/${total}`);
    // Just under / exactly at three quarters of 20: 14 and 15.
    assert.equal(working(14, 20), '◑ 14/20');
    assert.equal(working(15, 20), '◕ 15/20');
    // Just under / exactly at half of 20: 9 and 10.
    assert.equal(working(9, 20), '◔ 9/20');
    assert.equal(working(10, 20), '◑ 10/20');
    for (const slot of ['○ 0/21', '◔ 3/21', '◑ 11/21', '◕ 17/21']) {
        assert.ok(!/\uFE0F/u.test(slot), 'no variation selector');
        assert.equal(readStatusSlot(`${slot} [Epic] Plugin system`), slot);
        assert.equal(stripStatusSlot(`${slot} [Epic] Plugin system`), '[Epic] Plugin system');
    }
    // Every issue merged: ✅ N/N, as before; ⚠️ unchanged on an epic.
    assert.equal(renderStatusSlot({ state: 'ready', progress: { merged: 21, total: 21 } }), '✅ 21/21');
    assert.equal(renderStatusSlot({ state: 'needs_attention', progress: { merged: 3, total: 21 } }), '⚠️ 3/21');
    // Ordinary pull requests keep 🔨.
    assert.equal(renderStatusSlot({ state: 'working' }), '🔨');
    assert.equal(withStatusSlot('[3545 by Claude Opus 5.5] Fix it', { state: 'working' }), '🔨 [3545 by Claude Opus 5.5] Fix it');
});

test('a legacy 🔨 epic title is rewritten to its circle as one slot', () => {
    const EPIC = '[Epic] Plugin system';
    assert.equal(readStatusSlot(`🔨 3/21 ${EPIC}`), '🔨 3/21', 'the legacy slot is still read as the slot');
    assert.equal(withStatusSlot(`🔨 3/21 ${EPIC}`, { state: 'working', progress: { merged: 3, total: 21 } }), `◔ 3/21 ${EPIC}`);
    assert.equal(withStatusSlot(`◔ 3/21 ${EPIC}`, { state: 'working', progress: { merged: 11, total: 21 } }), `◑ 11/21 ${EPIC}`);
    assert.equal(withStatusSlot(`◕ 20/21 ${EPIC}`, { state: 'ready', progress: { merged: 21, total: 21 } }), `✅ 21/21 ${EPIC}`);
    assert.equal(withStatusSlot(`◔ 3/21 ${EPIC}`, { state: 'needs_attention', progress: { merged: 3, total: 21 } }), `⚠️ 3/21 ${EPIC}`);
    assert.equal(withStatusSlot(`◔ 3/21 ${EPIC}`, null), EPIC);
    // A circle is the slot only with its count.
    for (const title of [`◔ ${EPIC}`, `◔3/21 ${EPIC}`, `● 3/21 ${EPIC}`]) assert.equal(stripStatusSlot(title), title, title);
});
