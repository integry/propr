// Runs a fixed set of node:test files for a CI proof and validates what the
// runner itself reports, rather than a hand-maintained test total.
//
// Results come from the structured reporter in node-test-proof-reporter.mjs.
// A proof passes only when every required file exists, its own process
// reported a per-file `test:summary` with at least one passing test and no
// failed, cancelled, skipped or todo tests or suites, the run summary and end-of-stream
// record are present, and the runner exited 0 within its budget. Adding a
// passing test to a required file needs no change here or in the wrappers.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const REPORTER_URL = new URL('./node-test-proof-reporter.mjs', import.meta.url).href;
const COUNT_KEYS = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites'];
const MAX_LISTED_TESTS = 10;
const INCOMPLETE_RUN_KINDS = new Set(['timeout', 'signal', 'process-error', 'missing-results', 'truncated-results', 'malformed-results']);

function canonicalPath(path) {
    try {
        return realpathSync.native(path);
    } catch {
        return resolve(path);
    }
}

function displayPath(root, path) {
    return relative(root, path).replaceAll('\\', '/') || path;
}

// Formats test names as `: "a", "b"`, or nothing when there are none.
function listTests(records) {
    if (records.length === 0) return '';
    const names = records.map(record => JSON.stringify(String(record.name)));
    const shown = names.slice(0, MAX_LISTED_TESTS).join(', ');
    return `: ${names.length > MAX_LISTED_TESTS ? `${shown} and ${names.length - MAX_LISTED_TESTS} more` : shown}`;
}

/**
 * Parses the reporter's JSON lines. `ended` is true only when the reporter
 * wrote its end record after the runner's event stream finished.
 */
export function parseProofResults(text) {
    const records = [];
    const malformed = [];
    let ended = false;
    const lines = text.split('\n');
    // Every complete record ends with a newline; a trailing fragment is a
    // record that was cut off mid-write.
    const fragment = lines.pop();
    if (fragment !== '') malformed.push(`line ${lines.length + 1} is incomplete`);
    lines.forEach((line, index) => {
        if (line === '') return;
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            malformed.push(`line ${index + 1} is not JSON`);
            return;
        }
        if (record === null || typeof record !== 'object' || typeof record.type !== 'string') {
            malformed.push(`line ${index + 1} is not a result record`);
        } else if (ended) {
            malformed.push(`line ${index + 1} follows the end record`);
        } else if (record.type === 'end') {
            ended = true;
        } else {
            records.push(record);
        }
    });
    return { records, malformed, ended };
}

function isValidCounts(counts) {
    return counts !== null && typeof counts === 'object'
        && COUNT_KEYS.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0);
}

function classifyFailures(failures) {
    const byKind = new Map();
    for (const record of failures) {
        // A suite or parent test fails when a child does; the child is the
        // failure worth reporting.
        if (record.failureType === 'subtestsFailed') continue;
        const kind = record.failureType === 'testTimeoutFailure' ? 'test-timeout'
            : record.failureType === 'cancelledByParent' ? 'cancelled'
                : record.failureType === 'hookFailure' ? 'hook-failure'
                    : 'assertion-failure';
        byKind.set(kind, [...(byKind.get(kind) ?? []), record]);
    }
    return byKind;
}

// The summary's skipped and todo counters cover tests only: a skipped suite
// is not counted and neither are the tests it suppresses, so the recorded
// skip and todo flags are checked on their own.
function describeFlagged(count, records) {
    const suites = records.filter(record => record.testType === 'suite').length;
    const tests = Math.max(count, records.length - suites);
    return [tests > 0 && `${tests} required tests`, suites > 0 && `${suites} required suites`]
        .filter(Boolean).join(' and ');
}

const FAILURE_DESCRIPTIONS = {
    'assertion-failure': 'failing tests',
    'test-timeout': 'tests exceeded their own timeout',
    cancelled: 'tests were cancelled',
    'hook-failure': 'test hooks failed',
};

/**
 * Validates one proof run. `files` are the required test files (absolute or
 * relative to `root`); `run` is the spawnSync result; `results` is the
 * reporter output, or undefined when it was never written.
 */
export function evaluateNodeTestProof({ root, files, run, timeoutMs, results }) {
    const problems = [];
    const add = (kind, message) => problems.push({ kind, message });
    const required = new Map(files.map(file => [canonicalPath(resolve(root, file)), displayPath(root, resolve(root, file))]));

    const timedOut = run.error?.code === 'ETIMEDOUT';
    if (timedOut) {
        add('timeout', `test runner did not finish within ${timeoutMs}ms and was stopped`);
    } else if (run.signal) {
        add('signal', `test runner was terminated by ${run.signal}`);
    } else if (run.error) {
        add('process-error', `test runner could not complete: ${run.error.code ?? run.error.message}`);
    } else if (run.status !== 0) {
        add('exit-status', `test runner exited with status ${run.status}`);
    }

    const parsed = typeof results === 'string' && results !== ''
        ? parseProofResults(results)
        : { records: [], malformed: [], ended: false };
    if (typeof results !== 'string' || results === '') {
        add('missing-results', 'test runner wrote no structured results');
    }
    if (parsed.malformed.length > 0) {
        add('malformed-results', `structured results are malformed: ${parsed.malformed.join('; ')}`);
    }
    if (results && !parsed.ended) {
        add('truncated-results', 'structured results end before the runner finished reporting');
    }

    const perFile = new Map([...required.keys()].map(file => [file, { summary: undefined, tests: [] }]));
    const unexpected = new Set();
    let runSummary;
    for (const record of parsed.records) {
        if (record.type === 'test:summary' && record.file === undefined) {
            if (runSummary) add('malformed-results', 'structured results contain more than one run summary');
            runSummary = record;
            continue;
        }
        if (typeof record.file !== 'string') {
            add('malformed-results', `a ${record.type} result does not name its file`);
            continue;
        }
        const entry = perFile.get(canonicalPath(record.file));
        if (!entry) {
            unexpected.add(displayPath(root, record.file));
            continue;
        }
        if (record.type === 'test:summary') {
            if (entry.summary) add('malformed-results', `${displayPath(root, record.file)} reported more than one summary`);
            if (!isValidCounts(record.counts)) {
                add('malformed-results', `${displayPath(root, record.file)} reported a summary without valid counts`);
                continue;
            }
            entry.summary = record;
        } else if (record.type === 'test:pass' || record.type === 'test:fail') {
            entry.tests.push(record);
        }
    }
    for (const file of unexpected) {
        add('unexpected-file', `results reported a file that is not part of this proof: ${file}`);
    }
    if (results && parsed.ended && !runSummary) {
        add('truncated-results', 'structured results have no run summary');
    }
    // After a timeout, signal, or cut-off or malformed results, files without
    // results are a consequence of that problem rather than empty files.
    const incomplete = problems.find(problem => INCOMPLETE_RUN_KINDS.has(problem.kind));

    const totals = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
    const fileCounts = [];
    const unreported = [];
    for (const [file, { summary, tests }] of perFile) {
        const name = required.get(file);
        const failures = tests.filter(record => record.type === 'test:fail');
        if (!summary) {
            if (failures.length > 0) {
                add('load-failure', `${name} failed before reporting results${listTests(failures)}`);
            } else if (incomplete) {
                unreported.push(name);
            } else {
                add('no-tests', `${name} reported no results: the file is empty, was not discovered, or exited before its tests reported`);
            }
            continue;
        }
        const { counts } = summary;
        for (const key of COUNT_KEYS) totals[key] += counts[key];
        fileCounts.push({ file: name, counts });

        const classified = classifyFailures(failures);
        for (const [kind, records] of classified) {
            add(kind, `${name}: ${FAILURE_DESCRIPTIONS[kind]}${listTests(records)}`);
        }
        if ((counts.failed > 0 || counts.cancelled > 0) && classified.size === 0) {
            add('assertion-failure', `${name} reported ${counts.failed} failed and ${counts.cancelled} cancelled tests`);
        }
        const skipped = tests.filter(record => record.skip);
        if (counts.skipped > 0 || skipped.length > 0) {
            add('skipped', `${name}: ${describeFlagged(counts.skipped, skipped)} were skipped${listTests(skipped)}`);
        }
        const todo = tests.filter(record => record.todo);
        if (counts.todo > 0 || todo.length > 0) {
            add('todo', `${name}: ${describeFlagged(counts.todo, todo)} are marked todo${listTests(todo)}`);
        }
        if (counts.passed === 0) {
            add('no-tests', `${name} executed no passing tests`);
        }
        if (summary.success !== true && counts.failed === 0 && counts.cancelled === 0) {
            add('runner-failure', `${name} reported an unsuccessful run without a failing test`);
        }
    }
    if (unreported.length > 0) incomplete.message += `; no results from ${unreported.join(', ')}`;

    return { ok: problems.length === 0, problems, totals, fileCounts };
}

function formatCounts(counts) {
    return `tests=${counts.tests} pass=${counts.passed} fail=${counts.failed} cancelled=${counts.cancelled} skipped=${counts.skipped} todo=${counts.todo}`;
}

/**
 * Runs `files` (relative to `root`) with node --test and validates the
 * structured results. Output is echoed through `write`; returns the
 * evaluation.
 */
export function runNodeTestProof({
    label,
    root,
    files,
    nodeArgs = [],
    timeoutMs,
    maxBuffer,
    env = process.env,
    write = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) },
}) {
    const report = (evaluation) => {
        if (evaluation.ok) {
            write.stdout(`${label}: files=${files.length} ${formatCounts(evaluation.totals)} budgetMs=${timeoutMs}\n`);
            for (const { file, counts } of evaluation.fileCounts) {
                write.stdout(`  ${file}: ${formatCounts(counts)}\n`);
            }
        } else {
            write.stderr(`${label} failed:\n`);
            for (const { kind, message } of evaluation.problems) write.stderr(`  [${kind}] ${message}\n`);
        }
        return evaluation;
    };

    const missing = files.filter((file) => {
        try {
            return !statSync(resolve(root, file)).isFile();
        } catch {
            return true;
        }
    });
    if (missing.length > 0) {
        return report({
            ok: false,
            problems: missing.map(file => ({ kind: 'missing-file', message: `required test file does not exist: ${displayPath(root, resolve(root, file))}` })),
            totals: undefined,
            fileCounts: [],
        });
    }

    // Inherited from an enclosing node --test, this variable would make the
    // proof report to that runner instead of through its own reporters.
    const { NODE_TEST_CONTEXT: _parentTestContext, ...childEnv } = env;
    const resultsDirectory = mkdtempSync(join(tmpdir(), 'propr-node-test-proof-'));
    const resultsPath = join(resultsDirectory, 'results.jsonl');
    try {
        const run = spawnSync(process.execPath, [
            ...nodeArgs,
            '--test',
            `--test-reporter=${REPORTER_URL}`, `--test-reporter-destination=${resultsPath}`,
            '--test-reporter=spec', '--test-reporter-destination=stdout',
            ...files.map(file => resolve(root, file)),
        ], {
            cwd: root,
            shell: false,
            windowsHide: true,
            encoding: 'utf8',
            env: childEnv,
            timeout: timeoutMs,
            maxBuffer,
        });
        write.stdout(run.stdout ?? '');
        write.stderr(run.stderr ?? '');
        let results;
        try {
            results = readFileSync(resultsPath, 'utf8');
        } catch {
            results = undefined;
        }
        return report(evaluateNodeTestProof({ root, files, run, timeoutMs, results }));
    } finally {
        rmSync(resultsDirectory, { recursive: true, force: true });
    }
}
