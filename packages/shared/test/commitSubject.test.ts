import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    COMMIT_SUBJECT_MAX_CHARS,
    assembleCommitMessage,
    buildCommitSubject,
    cleanCommitTitle,
    epicSquashCommitFields,
    inferCommitType,
    isAcceptableCommitDescription,
    isProprAgentCommit,
    normalizeCommitDescription,
    parseCommitSubject,
    proprAgentTrailer,
    stripProprAgentTrailer,
} from '../src/commitSubject.js';

// The 0.9.2 release check (finding G3) quoted this subject.
const FIRST_PERSON_SUMMARY = 'I fixed both selected findings, F1 and F2, and the unit and browser tests for them pass.';

test('a first-person summary is never the subject: the title is used instead', () => {
    const subject = buildCommitSubject({
        generated: FIRST_PERSON_SUMMARY, title: 'Keep the create dialog open after saving', fallback: 'resolve issue #1', paths: ['ui/src/Dialog.tsx'],
    });
    assert.equal(subject, 'feat: keep the create dialog open after saving');
    assert.doesNotMatch(subject, /\bI\b|tests? .*pass/);
});

test('an imperative generated description is used and normalized', () => {
    assert.equal(
        buildCommitSubject({ generated: '"Fix: Stop retrying uploads on a 401."', title: 'Upload retries', fallback: 'x', paths: ['src/upload.ts'] }),
        'fix: stop retrying uploads on a 401',
    );
    assert.equal(normalizeCommitDescription('**Subject:** Add `--json` output\nmore text'), 'add `--json` output');
    assert.equal(normalizeCommitDescription('API: return 404 for unknown tasks'), 'API: return 404 for unknown tasks');
    assert.equal(normalizeCommitDescription('feat(ai): Keep the dialog open'), 'keep the dialog open');
    assert.equal(normalizeCommitDescription('Fleet: rotate keys'), 'fleet: rotate keys');
});

test('narration and test reports are rejected as descriptions', () => {
    for (const text of ['I fixed the dialog', "I've added Gemini 4 Carbon", 'we now keep it open', 'All tests pass', 'Tests now pass after the fix', '6 of 6 tests pass', '']) {
        assert.equal(isAcceptableCommitDescription(text), false, text);
    }
    for (const text of ['handle I/O errors in uploads', 'include In-progress tasks', 'fix failing login test', 'add i18n keys']) {
        assert.equal(isAcceptableCommitDescription(text), true, text);
    }
});

test('an over-long subject is cut at a word boundary within 72 characters', () => {
    const subject = buildCommitSubject({
        title: 'Commit subjects: a short imperative line generated separately from the run summary for every commit',
        fallback: 'x', paths: ['src/a.ts', 'docs/a.md'],
    });
    assert.ok(subject.length <= COMMIT_SUBJECT_MAX_CHARS, subject);
    assert.match(subject, /^chore: commit subjects: a short imperative line generated separately…$/);
    assert.ok(!/\s…$/.test(subject));
});

test('generation failure falls back to the title, then to the fixed subject, never to the summary', () => {
    assert.equal(buildCommitSubject({ generated: null, title: '[3736 by Claude Opus 5.5] Fix the login redirect (#3750)', fallback: 'resolve issue #3736' }), 'fix: fix the login redirect');
    assert.equal(buildCommitSubject({ generated: FIRST_PERSON_SUMMARY, title: '', fallback: 'resolve issue #12' }), 'fix: resolve issue #12');
    assert.equal(buildCommitSubject({ generated: undefined, title: null, fallback: 'apply follow-up changes from PR #3' }), 'chore: apply follow-up changes from PR #3');
});

test('the conventional-commit type follows the changed paths', () => {
    const cases: Array<[string[], string]> = [
        [['docs/guide.md', 'README.md'], 'docs'],
        [['test/a.test.ts', 'packages/core/test/b.test.ts'], 'test'],
        [['.github/workflows/ci.yml'], 'ci'],
        [['package.json', 'package-lock.json'], 'build'],
        [['test/a.test.ts', 'docs/a.md'], 'test'],
        [['requirements.txt'], 'build'],
        [['requirements-dev.txt', 'requirements.txt'], 'build'],
        [['docs/requirements.txt'], 'build'],
        [['docs/package.json', 'docs/package-lock.json'], 'build'],
    ];
    for (const [paths, type] of cases) assert.equal(inferCommitType({ paths, title: 'Add retries to uploads' }), type, paths.join(','));
});

test('a dependency manifest with a docs extension is not counted as documentation', () => {
    assert.equal(inferCommitType({ paths: ['requirements.txt'], title: 'Upgrade requests to 2.32' }), 'build');
    assert.equal(inferCommitType({ paths: ['README.md', 'requirements-dev.txt'], title: 'Add pytest-xdist' }), 'feat');
    assert.equal(inferCommitType({ paths: ['test/test_api.py', 'requirements-dev.txt'], title: 'Add pytest-xdist' }), 'feat');
    assert.equal(inferCommitType({ paths: ['notes.txt'], title: 'Add pytest-xdist' }), 'docs');
});

test('mixed paths take the type from the title wording, chore when unclear', () => {
    const paths = ['src/a.ts', 'test/a.test.ts'];
    assert.equal(inferCommitType({ paths, title: 'Fix crash when adding an item' }), 'fix');
    assert.equal(inferCommitType({ paths, title: 'Add a retry when the upload fails' }), 'feat');
    assert.equal(inferCommitType({ paths, title: 'Rename the queue helpers' }), 'refactor');
    assert.equal(inferCommitType({ paths, title: 'docs: explain the queue' }), 'docs');
    assert.equal(inferCommitType({ paths, title: 'Commit subjects for agent runs' }), 'chore');
    assert.equal(inferCommitType({ paths: [], title: undefined }), 'chore');
});

test('the agent trailer is the last paragraph and marks the commit as ProPR-made', () => {
    const message = assembleCommitMessage('fix: keep the dialog open', FIRST_PERSON_SUMMARY, [proprAgentTrailer('claude', 'claude-opus-5-5')]);
    assert.equal(message, `fix: keep the dialog open\n\n${FIRST_PERSON_SUMMARY}\n\nProPR-Agent: claude/claude-opus-5-5`);
    assert.equal(proprAgentTrailer(undefined, 'gpt-5'), 'ProPR-Agent: gpt-5');
    assert.equal(stripProprAgentTrailer(message), `fix: keep the dialog open\n\n${FIRST_PERSON_SUMMARY}`);
    assert.equal(isProprAgentCommit(message), true);
});

test('old and new history both parse', () => {
    assert.deepEqual(parseCommitSubject('feat(ai): I fixed F3. More'), { type: 'feat', scope: 'ai', description: 'I fixed F3. More' });
    assert.deepEqual(parseCommitSubject('fix: keep the dialog open\n\nbody'), { type: 'fix', scope: null, description: 'keep the dialog open' });
    assert.deepEqual(parseCommitSubject('I added the workflow'), { type: null, scope: null, description: 'I added the workflow' });
    assert.equal(isProprAgentCommit('feat(ai): I fixed F3.'), true);
    assert.equal(isProprAgentCommit('fix: keep the dialog open'), false);
});

test('a first-person or test-report title is no subject either: the fixed fallback is used', () => {
    for (const title of ['I cannot log in', 'All tests pass', '[12 by Codex] We broke the export (#13)']) {
        const subject = buildCommitSubject({ generated: null, title, fallback: 'resolve issue #12' });
        assert.match(subject, /^[a-z]+: resolve issue #12$/, `${title} → ${subject}`);
    }
    // A rejected generated description still gives way to an acceptable title, and an unacceptable title to the fallback.
    assert.equal(buildCommitSubject({ generated: FIRST_PERSON_SUMMARY, title: 'I cannot log in', fallback: 'resolve issue #7' }), 'fix: resolve issue #7');
});

test('the epic squash subject skips a first-person or test-report sub-PR title', () => {
    assert.equal(
        epicSquashCommitFields({ number: 5, title: 'I cannot log in' }, 'fix: keep the session cookie\n\nKept it.').commit_title,
        'fix: keep the session cookie (#5)',
    );
    assert.equal(epicSquashCommitFields({ number: 6, title: 'All tests pass' }, null).commit_title, 'test: merge pull request #6 (#6)');
    assert.equal(epicSquashCommitFields({ number: 7, title: 'My login fix' }, `feat(ai): ${FIRST_PERSON_SUMMARY}`).commit_title, 'fix: merge pull request #7 (#7)');
});

test('the epic squash subject comes from the sub-PR title, not the first commit', () => {
    const fields = epicSquashCommitFields(
        { number: 3731, title: '[3726 by Claude Opus 5.5] Fold an aggregate CI job under the shard that made the whole run fail' },
        `feat(ai): ${FIRST_PERSON_SUMMARY}\n\nMore detail.`,
    );
    assert.ok(fields.commit_title.length <= COMMIT_SUBJECT_MAX_CHARS, fields.commit_title);
    assert.match(fields.commit_title, /^ci: fold an aggregate CI job under the shard that made the… \(#3731\)$/);
    // An old summary-as-subject commit keeps its whole message in the body.
    assert.equal(fields.commit_message, `feat(ai): ${FIRST_PERSON_SUMMARY}\n\nMore detail.`);

    const newStyle = epicSquashCommitFields({ number: 5, title: 'Dialog follow-ups' }, 'fix: keep the dialog open\n\nKept it open.\n\nProPR-Agent: claude/opus');
    assert.equal(newStyle.commit_title, 'fix: dialog follow-ups (#5)');
    assert.equal(newStyle.commit_message, 'Kept it open.\n\nProPR-Agent: claude/opus');

    assert.equal(epicSquashCommitFields({ number: 9, title: '' }, null).commit_title, 'chore: merge pull request #9 (#9)');
});

test('cleanCommitTitle strips the run prefix and issue ref, and stays linear on long whitespace runs', () => {
    assert.equal(cleanCommitTitle('  [3726 by Claude Opus 5.5]  Fold the CI job  (#3731)  '), 'Fold the CI job');
    assert.equal(cleanCommitTitle('[WIP] Keep the [draft] label (#12) here'), '[WIP] Keep the [draft] label (#12) here');
    assert.equal(cleanCommitTitle('[1 by X] (#4)'), null);
    const tabs = '\t'.repeat(200_000);
    const started = Date.now();
    assert.equal(cleanCommitTitle(`[${tabs}x${tabs}`), `[${tabs}x`);
    assert.equal(cleanCommitTitle(`a${tabs}(#${tabs}`), `a${tabs}(#`);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});
