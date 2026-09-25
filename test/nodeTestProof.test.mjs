import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { describe, test } from 'node:test';
import { evaluateNodeTestProof, parseProofResults, runNodeTestProof } from '../scripts/lib/node-test-proof.mjs';

// Several fixtures fail or hang on purpose, so they live outside `test/`,
// where a bare `node --test` (npm test) would discover and run them.
const REPO_ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = resolve(REPO_ROOT, 'scripts', 'lib', 'fixtures', 'nodeTestProof');

function proof(files, { root = FIXTURES, timeoutMs = 30_000 } = {}) {
    const output = { stdout: '', stderr: '' };
    const evaluation = runNodeTestProof({
        label: 'Fixture proof',
        root,
        files,
        timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        write: {
            stdout: (text) => { output.stdout += text; },
            stderr: (text) => { output.stderr += text; },
        },
    });
    return { ...evaluation, output };
}

const kinds = evaluation => evaluation.problems.map(problem => problem.kind).sort();
const messages = evaluation => evaluation.problems.map(problem => problem.message).join('\n');

describe('node test proof runs', () => {
    test('an additional passing test is accepted without editing the proof', () => {
        const root = mkdtempSync(join(tmpdir(), 'propr-node-test-proof-fixture-'));
        try {
            copyFileSync(join(FIXTURES, 'passing.mjs'), join(root, 'growing.mjs'));
            const before = proof(['growing.mjs'], { root });
            assert.equal(before.ok, true, messages(before));
            assert.equal(before.totals.passed, 2);

            appendFileSync(join(root, 'growing.mjs'), "test('newly added test', () => assert.ok(true));\n");
            const after = proof(['growing.mjs'], { root });
            assert.equal(after.ok, true, messages(after));
            assert.equal(after.totals.passed, 3);
            assert.match(after.output.stdout, /Fixture proof: files=1 tests=3 pass=3 fail=0 cancelled=0 skipped=0 todo=0/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('nested suites and subtests count each test once and suites separately', () => {
        const evaluation = proof(['nested.mjs', 'passing.mjs']);
        assert.equal(evaluation.ok, true, messages(evaluation));
        const nested = evaluation.fileCounts.find(entry => entry.file === 'nested.mjs');
        assert.equal(nested.counts.tests, 4);
        assert.equal(nested.counts.passed, 4);
        assert.equal(nested.counts.suites, 2);
        assert.equal(evaluation.totals.passed, 6);
    });

    test('a missing required file fails even when the other files pass', () => {
        const evaluation = proof(['passing.mjs', 'absent.mjs']);
        assert.equal(evaluation.ok, false);
        assert.deepEqual(kinds(evaluation), ['missing-file']);
        assert.match(messages(evaluation), /required test file does not exist: absent\.mjs/);
        assert.match(evaluation.output.stderr, /Fixture proof failed:\n {2}\[missing-file\]/);
    });

    test('an empty required file fails even when the other files pass', () => {
        const evaluation = proof(['passing.mjs', 'empty.mjs']);
        assert.equal(evaluation.ok, false);
        assert.deepEqual(kinds(evaluation), ['no-tests']);
        assert.match(messages(evaluation), /^empty\.mjs reported no results/);
    });

    test('a file with only an empty suite executes no tests', () => {
        const evaluation = proof(['passing.mjs', 'suite-only.mjs']);
        assert.deepEqual(kinds(evaluation), ['no-tests']);
        assert.match(messages(evaluation), /^suite-only\.mjs executed no passing tests$/);
    });

    test('a file that exits before reporting fails although the runner exits 0', () => {
        const evaluation = proof(['passing.mjs', 'early-exit.mjs']);
        assert.deepEqual(kinds(evaluation), ['no-tests']);
        assert.match(messages(evaluation), /^early-exit\.mjs reported no results/);
    });

    test('a file that fails to load is reported as a load failure', () => {
        const evaluation = proof(['passing.mjs', 'broken.mjs']);
        assert.deepEqual(kinds(evaluation), ['exit-status', 'load-failure']);
        assert.match(messages(evaluation), /broken\.mjs failed before reporting results/);
    });

    test('assertion failures name the failing test', () => {
        const evaluation = proof(['passing.mjs', 'failing.mjs']);
        assert.deepEqual(kinds(evaluation), ['assertion-failure', 'exit-status']);
        assert.match(messages(evaluation), /failing\.mjs: failing tests: "failing assertion"/);
        assert.doesNotMatch(messages(evaluation), /passing neighbour/);
    });

    test('cancelled tests and per-test timeouts are distinguished from assertions', () => {
        const evaluation = proof(['cancelled.mjs']);
        assert.deepEqual(kinds(evaluation), ['cancelled', 'exit-status', 'test-timeout']);
        assert.match(messages(evaluation), /tests were cancelled: "abandoned subtest"/);
        assert.match(messages(evaluation), /tests exceeded their own timeout: "test over its own timeout"/);
    });

    test('skipped-only and todo-only files do not satisfy the proof', () => {
        const skipped = proof(['passing.mjs', 'skipped.mjs']);
        assert.deepEqual(kinds(skipped), ['no-tests', 'skipped']);
        assert.match(messages(skipped), /skipped\.mjs: 1 required tests were skipped: "skipped required test"/);

        const todo = proof(['passing.mjs', 'todo.mjs']);
        assert.deepEqual(kinds(todo), ['no-tests', 'todo']);
        assert.match(messages(todo), /todo\.mjs: 1 required tests are marked todo: "unfinished required test"/);
    });

    test('a skipped or todo suite fails although another test in the file passes', () => {
        const skipped = proof(['passing.mjs', 'skipped-suite.mjs']);
        assert.deepEqual(kinds(skipped), ['skipped']);
        assert.equal(skipped.fileCounts.find(entry => entry.file === 'skipped-suite.mjs').counts.skipped, 0);
        assert.match(messages(skipped), /^skipped-suite\.mjs: 1 required suites were skipped: "skipped required suite"$/);

        const todo = proof(['passing.mjs', 'todo-suite.mjs']);
        assert.deepEqual(kinds(todo), ['todo']);
        assert.equal(todo.fileCounts.find(entry => entry.file === 'todo-suite.mjs').counts.todo, 0);
        assert.match(messages(todo), /^todo-suite\.mjs: 1 required suites are marked todo: "unfinished required suite"$/);
    });

    test('fixtures are outside the default node --test discovery', () => {
        // Node's defaults match any file under a `test` directory and
        // test-named files anywhere.
        assert.equal(relative(REPO_ROOT, FIXTURES).split(sep).includes('test'), false);
        const discoverable = readdirSync(FIXTURES)
            .filter(name => /^test([-.]|$)|[._-]test\./.test(name));
        assert.deepEqual(discoverable, []);
    });

    test('a run over its budget is reported as a timeout, not as empty files', () => {
        const evaluation = proof(['hang.mjs'], { timeoutMs: 2_000 });
        assert.equal(evaluation.ok, false);
        assert.equal(evaluation.problems[0].kind, 'timeout');
        assert.match(evaluation.problems[0].message,
            /did not finish within 2000ms and was stopped; no results from hang\.mjs/);
        assert.equal(kinds(evaluation).includes('no-tests'), false);
    });
});

describe('node test proof result evaluation', () => {
    const passingFile = join(FIXTURES, 'passing.mjs');
    const counts = { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 1, suites: 0 };
    const records = [
        { type: 'test:pass', file: passingFile, name: 'first passing test', nesting: 0, testType: 'test' },
        { type: 'test:summary', file: passingFile, counts, success: true },
        { type: 'test:summary', counts, success: true },
        { type: 'end' },
    ];
    const serialize = values => values.map(value => `${JSON.stringify(value)}\n`).join('');
    const evaluate = (results, run = { status: 0, signal: null }) => evaluateNodeTestProof({
        root: FIXTURES, files: ['passing.mjs'], run, timeoutMs: 1_000, results,
    });

    test('complete results from a clean run pass', () => {
        const evaluation = evaluate(serialize(records));
        assert.equal(evaluation.ok, true, messages(evaluation));
        assert.equal(evaluation.totals.passed, 1);
    });

    test('skip and todo flags fail even when the summary counters are zero', () => {
        const flagged = flags => ({ type: 'test:pass', file: passingFile, name: 'flagged suite', nesting: 0, testType: 'suite', skip: false, todo: false, ...flags });
        const skipped = evaluate(serialize([records[0], flagged({ skip: true }), ...records.slice(1)]));
        assert.deepEqual(kinds(skipped), ['skipped']);
        assert.match(messages(skipped), /1 required suites were skipped: "flagged suite"/);

        const todo = evaluate(serialize([records[0], flagged({ todo: true }), ...records.slice(1)]));
        assert.deepEqual(kinds(todo), ['todo']);
        assert.match(messages(todo), /1 required suites are marked todo: "flagged suite"/);
    });

    test('absent results fail', () => {
        assert.deepEqual(kinds(evaluate(undefined)), ['missing-results']);
        assert.deepEqual(kinds(evaluate('')), ['missing-results']);
    });

    test('results without the end record or run summary are truncated', () => {
        const withoutEnd = evaluate(serialize(records.slice(0, -1)));
        assert.deepEqual(kinds(withoutEnd), ['truncated-results']);

        const withoutFileSummary = evaluate(serialize([records[0]]));
        assert.deepEqual(kinds(withoutFileSummary), ['truncated-results']);
        assert.match(messages(withoutFileSummary), /no results from passing\.mjs/);

        const withoutRunSummary = evaluate(serialize([records[0], records[1], records[3]]));
        assert.deepEqual(kinds(withoutRunSummary), ['truncated-results']);
    });

    test('malformed and cut-off records fail', () => {
        const cutOff = evaluate(serialize(records).slice(0, -3));
        assert.deepEqual(kinds(cutOff), ['malformed-results', 'truncated-results']);

        const notJson = evaluate(`not json\n${serialize(records)}`);
        assert.deepEqual(kinds(notJson), ['malformed-results']);

        const badCounts = evaluate(serialize([records[0], { ...records[1], counts: { passed: 1 } }, ...records.slice(2)]));
        assert.deepEqual(kinds(badCounts), ['malformed-results']);
        assert.match(messages(badCounts), /no results from passing\.mjs/);
    });

    test('results from a file outside the proof fail', () => {
        const other = { ...records[1], file: join(FIXTURES, 'nested.mjs') };
        assert.deepEqual(kinds(evaluate(serialize([...records.slice(0, 2), other, ...records.slice(2)]))), ['unexpected-file']);
    });

    test('process signals, errors and exit status fail with their own diagnostics', () => {
        const signal = evaluate(serialize(records.slice(0, 2)), { status: null, signal: 'SIGKILL' });
        assert.deepEqual(kinds(signal), ['signal', 'truncated-results']);
        assert.match(signal.problems[0].message, /terminated by SIGKILL/);

        const error = evaluate(undefined, { status: null, signal: null, error: Object.assign(new Error('spawn'), { code: 'ENOENT' }) });
        assert.deepEqual(kinds(error), ['missing-results', 'process-error']);
        assert.match(messages(error), /could not complete: ENOENT/);

        const timeout = evaluate(undefined, { status: null, signal: 'SIGTERM', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) });
        assert.equal(timeout.problems[0].kind, 'timeout');
        assert.equal(kinds(timeout).includes('signal'), false);

        const exitStatus = evaluate(serialize(records), { status: 1, signal: null });
        assert.deepEqual(kinds(exitStatus), ['exit-status']);
    });

    test('parsing keeps only records before the end record', () => {
        const parsed = parseProofResults(serialize([...records, records[0]]));
        assert.equal(parsed.ended, true);
        assert.equal(parsed.records.length, 3);
        assert.deepEqual(parsed.malformed, ['line 5 follows the end record']);
    });
});
