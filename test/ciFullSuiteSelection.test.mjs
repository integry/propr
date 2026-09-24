import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

import { SURFACES, classifyChanges } from '../scripts/ci-change-classification.mjs';

// Job selection and the required gate of the Full Test Suite
// (.github/workflows/pr-test-on-label.yml). The workflow's own `if`
// expressions, job outputs and gate script are evaluated here, so these tests
// prove what GitHub would run rather than matching YAML substrings.

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const CLASSIFIER = join(REPOSITORY, 'scripts', 'ci-change-classification.mjs');
const readWorkflow = name => readFileSync(join(REPOSITORY, '.github', 'workflows', name), 'utf8');
const fullSuite = readWorkflow('pr-test-on-label.yml');

const scratch = mkdtempSync(join(tmpdir(), 'propr-ci-full-suite-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let scratchCounter = 0;
const freshDirectory = (name) => {
    scratchCounter += 1;
    const directory = join(scratch, `${String(scratchCounter).padStart(2, '0')}-${name}`);
    mkdirSync(directory, { recursive: true });
    return directory;
};

// The file set of PR #2513 at 799fa75aa7dad7af1ffdd688dde3c5fd649a7d23: review
// job implementation and its tests, nothing else.
const PR_2513 = Object.freeze([
    ['M', 'src/jobs/reviewCommentGatherer.ts'],
    ['M', 'src/jobs/reviewFindingSelector.ts'],
    ['M', 'src/jobs/reviewOutputParser.ts'],
    ['M', 'src/jobs/reviewPromptBuilder.ts'],
    ['A', 'src/jobs/reviewRecordFields.ts'],
    ['M', 'test/reviewCommentGatherer.test.ts'],
    ['A', 'test/reviewMultilineEvidence.test.ts'],
    ['M', 'test/reviewPromptBuilder.test.ts'],
]);

// --- workflow reading -------------------------------------------------------

function jobBlock(workflow, job) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    assert.ok(start >= 0, `job ${job} exists`);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 1);
}

function extractRunBlock(block, stepName) {
    const lines = block.slice(block.indexOf(`- name: ${stepName}`)).split('\n');
    const runLine = lines.findIndex(line => line.trim() === 'run: |');
    assert.ok(runLine > 0, `${stepName} must use a run block`);
    const indent = lines[runLine + 1].match(/^ */)[0].length;
    const result = [];
    for (const line of lines.slice(runLine + 1)) {
        if (line.trim() !== '' && line.match(/^ */)[0].length < indent) break;
        result.push(line.slice(indent));
    }
    return result.join('\n');
}

/** A job-level `if:`, either inline or folded (`>-`). */
function jobCondition(block) {
    const lines = block.split('\n');
    const start = lines.findIndex(line => /^ {4}if: /.test(line));
    if (start < 0) return null;
    const value = lines[start].replace(/^ {4}if: /, '');
    if (value !== '>-') return value;
    const folded = [];
    for (const line of lines.slice(start + 1)) {
        if (!/^ {6}/.test(line)) break;
        folded.push(line.trim());
    }
    return folded.join(' ');
}

function jobNeeds(block) {
    const value = block.match(/\n {4}needs: (.+)\n/)?.[1];
    if (!value) return [];
    return value.startsWith('[') ? value.slice(1, -1).split(',').map(name => name.trim()) : [value.trim()];
}

/** `KEY: ${{ expression }}` entries of an indented mapping that follows `header`. */
function expressionMap(block, header) {
    const start = block.indexOf(header);
    assert.ok(start >= 0, `${header.trim()} exists`);
    const lines = block.slice(start + header.length).split('\n');
    const indent = lines[0].match(/^ */)[0].length;
    const entries = {};
    for (const line of lines) {
        if (line.match(/^ */)[0].length !== indent) break;
        const match = line.trim().match(/^([A-Za-z_][\w-]*): \$\{\{ (.+) \}\}$/);
        assert.ok(match, `unexpected mapping line: ${line}`);
        entries[match[1]] = match[2];
    }
    return entries;
}

/**
 * Evaluate a GitHub expression. Property access on a missing object yields
 * undefined rather than throwing, as GitHub yields null.
 */
function evaluate(expression, { github = {}, needs = {}, steps = {}, cancelled = false }) {
    const body = expression.trim().replace(/^\$\{\{/, '').replace(/\}\}$/, '')
        .replace(/\b(github|needs|steps)((?:\.[A-Za-z_][\w-]*)+)/g, (_, root, path) =>
            root + path.split('.').slice(1).map(key => `?.[${JSON.stringify(key)}]`).join(''));
    return new Function('github', 'needs', 'steps', 'cancelled', 'always', `return (${body});`)(
        github, needs, steps, () => cancelled, () => true);
}

const STATUS_FUNCTION = /\b(always|cancelled|success|failure)\(\)/;

/**
 * Whether GitHub starts a job. Without a status function an `if` is implicitly
 * `success() && (...)`, which skips the job when any dependency did not
 * succeed. That default is exactly what a failed classifier must not trigger.
 */
function jobRuns(job, context) {
    const block = jobBlock(fullSuite, job);
    const condition = jobCondition(block);
    if (condition && STATUS_FUNCTION.test(condition)) return Boolean(evaluate(condition, context));
    if (context.cancelled) return false;
    const dependencies = jobNeeds(block).map(name => context.needs[name]?.result);
    if (dependencies.some(result => result !== 'success')) return false;
    return condition ? Boolean(evaluate(condition, context)) : true;
}

// --- classifier and run simulation ------------------------------------------

/** Step outputs, as the composite action writes them, for a decision. */
function classifierOutputs(decision) {
    return {
        status: decision.status,
        broad: String(decision.broad),
        ...Object.fromEntries(SURFACES.map(surface => [surface, String(decision.surfaces[surface])])),
    };
}

const narrowDecision = paths => classifyChanges({
    files: paths.map(entry => Array.isArray(entry) ? { status: entry[0], path: entry[1] } : { status: 'M', path: entry }),
});

/**
 * Simulate one run: which jobs start, what the classifier job exports, and
 * whether the required `Run Full Test Suite` gate passes. Jobs that start are
 * assumed to succeed unless `results` overrides them.
 *
 * `classifier` is a decision object, `'failure'` (the job failed before
 * writing outputs) or `'cancelled'`.
 */
function simulateRun({ eventName = 'pull_request', draft = false, classifier, results = {}, coverage = 'success', cancelled = false }) {
    const github = {
        event_name: eventName,
        event: eventName === 'pull_request' ? { pull_request: { draft } } : {},
    };
    const needs = {};
    const context = { github, needs, cancelled };

    const classifyBlock = jobBlock(fullSuite, 'classify');
    if (!jobRuns('classify', context)) {
        needs.classify = { result: 'skipped', outputs: {} };
    } else if (classifier === 'failure' || classifier === 'cancelled') {
        needs.classify = { result: classifier, outputs: {} };
    } else {
        const steps = { classify: { outputs: classifierOutputs(classifier) } };
        const mapping = expressionMap(classifyBlock, '\n    outputs:\n');
        const outputs = Object.fromEntries(Object.entries(mapping)
            .map(([key, expression]) => [key, evaluate(expression, { steps }) ?? '']));
        needs.classify = { result: 'success', outputs };
    }

    const started = {};
    for (const job of ['shard', 'docs', 'native-electron']) {
        started[job] = jobRuns(job, context);
        needs[job] = { result: started[job] ? (results[job] ?? 'success') : 'skipped', outputs: {} };
    }

    const gateRuns = jobRuns('test', context);
    let gate = null;
    if (gateRuns) {
        const gateBlock = jobBlock(fullSuite, 'test');
        const step = gateBlock.slice(gateBlock.indexOf('- name: Enforce shard and docs results'));
        const environment = Object.fromEntries(Object.entries(expressionMap(step, '\n        env:\n'))
            .map(([key, expression]) => [key, String(evaluate(expression, {
                github, needs, steps: { coverage: { outcome: coverage } },
            }) ?? '')]));
        gate = runGate(environment);
    }
    return { started, needs, gateRuns, gate };
}

const gateScript = extractRunBlock(jobBlock(fullSuite, 'test'), 'Enforce shard and docs results');

function runGate(environment) {
    const directory = freshDirectory('gate');
    const summary = join(directory, 'summary.md');
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['-e', '-c', gateScript], {
        cwd: directory,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, ...environment },
    });
    return { status: result.status, stdout: result.stdout ?? '', summary: readFileSync(summary, 'utf8') };
}

// --- git fixtures -----------------------------------------------------------

const git = (directory, args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();

function commitAll(directory, files, message) {
    for (const [path, contents] of Object.entries(files)) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), contents);
    }
    git(directory, ['add', '--all']);
    git(directory, ['commit', '--quiet', '--allow-empty', '-m', message]);
    return git(directory, ['rev-parse', 'HEAD']);
}

/** Run the classifier CLI the way the composite action does. */
function classifyWithCli(directory, base, head) {
    const output = join(freshDirectory('output'), 'github-output.txt');
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [CLASSIFIER, '--github-output', '--no-fetch'], {
        cwd: directory,
        encoding: 'utf8',
        env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            PROPR_CLASSIFY_BASE_SHA: base,
            PROPR_CLASSIFY_HEAD_SHA: head,
            PROPR_CLASSIFY_EVENT: 'pull_request',
        },
    });
    assert.equal(result.status, 0, result.stderr);
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n')
        .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    return {
        status: outputs.status,
        broad: outputs.broad === 'true',
        surfaces: Object.fromEntries(SURFACES.map(surface => [surface, outputs[surface] === 'true'])),
    };
}

function pr2513Repository() {
    const directory = freshDirectory('pr-2513');
    git(directory, ['init', '--quiet', '--initial-branch=main']);
    git(directory, ['config', 'user.email', 'ci@example.com']);
    git(directory, ['config', 'user.name', 'Propr CI']);
    git(directory, ['config', 'commit.gpgsign', 'false']);
    const existing = PR_2513.filter(([status]) => status === 'M').map(([, path]) => path);
    const base = commitAll(directory, {
        ...Object.fromEntries(existing.map(path => [path, 'export const before = 1;\n'])),
        'docs/docs/intro.md': '# Intro\n',
        'apps/desktop/scripts/electron-frame-semantics.test.mjs': 'export {};\n',
    }, 'base');
    git(directory, ['checkout', '--quiet', '-b', 'feature']);
    const head = commitAll(directory, Object.fromEntries(PR_2513.map(([, path]) => [path, 'export const after = 2;\n'])), 'review job');
    return { directory, base, head };
}

// --- job selection ----------------------------------------------------------

describe('Full Test Suite job selection', () => {
    test('PR #2513 runs all four backend shards and skips docs and native Electron', () => {
        const { directory, base, head } = pr2513Repository();
        const decision = classifyWithCli(directory, base, head);
        assert.equal(decision.status, 'ok');
        assert.equal(decision.broad, false);
        assert.equal(decision.surfaces.docs, false);
        assert.equal(decision.surfaces.desktop, false);

        const run = simulateRun({ classifier: decision });
        assert.deepEqual(run.started, { shard: true, docs: false, 'native-electron': false });
        assert.match(jobBlock(fullSuite, 'shard'), /matrix:\n\s+shard: \[1, 2, 3, 4\]\n/);
        assert.equal(run.gate.status, 0, run.gate.stdout);
        assert.match(run.gate.stdout, /Docs site validation proved inapplicable/);
        assert.match(run.gate.stdout, /Hosted native Electron units proved inapplicable/);
        assert.match(run.gate.summary, /not applicable to this change set/);
    });

    for (const [label, paths, expected] of [
        ['a docs site page', ['docs/docs/intro.md'], { docs: true, 'native-electron': false }],
        ['the docs site configuration', ['docs/docusaurus.config.ts'], { docs: true, 'native-electron': false }],
        ['a native Electron unit', ['apps/desktop/scripts/electron-frame-semantics.test.mjs'], { docs: false, 'native-electron': true }],
        ['a native Electron probe', ['apps/desktop/scripts/electron-pairing-zstd-probe.cjs'], { docs: false, 'native-electron': true }],
        ['desktop application source', ['apps/desktop/src/main.ts'], { docs: false, 'native-electron': true }],
        // Shared dependencies activate every consumer they affect.
        ['@propr/client, whose dist the zstd probe loads', ['packages/client/src/pairingProtocol.ts'], { docs: false, 'native-electron': true }],
        ['@propr/shared, which @propr/client depends on', ['packages/shared/src/index.ts'], { docs: false, 'native-electron': true }],
        ['@propr/cli, which the desktop app bundles', ['packages/cli/src/index.ts'], { docs: false, 'native-electron': true }],
        ['the renderer the desktop app embeds', ['propr-ui/src/App.tsx'], { docs: false, 'native-electron': true }],
        ['docs and desktop together', ['docs/docs/intro.md', 'apps/desktop/src/main.ts'], { docs: true, 'native-electron': true }],
    ]) {
        test(`${label} runs the relevant validation`, () => {
            const run = simulateRun({ classifier: narrowDecision(paths) });
            assert.deepEqual(run.started, { shard: true, ...expected });
            assert.equal(run.gate.status, 0, run.gate.stdout);
        });
    }

    for (const [label, path] of [
        ['the root lockfile', 'package-lock.json'],
        ['the docs site lockfile', 'docs/package-lock.json'],
        ['the UI lockfile', 'propr-ui/package-lock.json'],
        ['the Node toolchain', '.nvmrc'],
        ['shared TypeScript configuration', 'tsconfig.json'],
        ['this workflow', '.github/workflows/pr-test-on-label.yml'],
        ['the classifier action', '.github/actions/classify-changes/action.yml'],
        ['the classifier', 'scripts/ci-change-classification.mjs'],
        ['the native Electron runner', 'scripts/run-test-suite.mjs'],
        ['this regression test', 'test/ciFullSuiteSelection.test.mjs'],
        ['the workspace setup the docs job runs', '.propr/setup.sh'],
        ['an unknown path', 'brand-new-workspace/index.ts'],
    ]) {
        test(`${label} runs docs and native Electron validation`, () => {
            const decision = narrowDecision([path]);
            assert.equal(decision.broad, true);
            const run = simulateRun({ classifier: decision });
            assert.deepEqual(run.started, { shard: true, docs: true, 'native-electron': true });
            assert.equal(run.gate.status, 0, run.gate.stdout);
        });
    }

    test('a dependency change in the UI manifest, which pins the docs job\'s Playwright, runs both', () => {
        const base = JSON.parse(readFileSync(join(REPOSITORY, 'propr-ui', 'package.json'), 'utf8'));
        const head = { ...base, devDependencies: { ...base.devDependencies, '@playwright/test': '0.0.0' } };
        const decision = classifyChanges({
            files: [{ status: 'M', path: 'propr-ui/package.json' }],
            manifests: { 'propr-ui/package.json': { base: JSON.stringify(base), head: JSON.stringify(head) } },
        });
        assert.equal(decision.broad, true);
        assert.deepEqual(simulateRun({ classifier: decision }).started, { shard: true, docs: true, 'native-electron': true });
    });

    test('an unresolvable diff falls back to running everything', () => {
        const { directory } = pr2513Repository();
        const decision = classifyWithCli(directory, '0'.repeat(40), '1'.repeat(40));
        assert.equal(decision.status, 'fallback');
        const run = simulateRun({ classifier: decision });
        assert.deepEqual(run.started, { shard: true, docs: true, 'native-electron': true });
        assert.equal(run.gate.status, 0, run.gate.stdout);
    });

    test('a failed classifier job runs everything instead of skipping through needs', () => {
        const run = simulateRun({ classifier: 'failure' });
        assert.deepEqual(run.started, { shard: true, docs: true, 'native-electron': true });
        assert.equal(run.gate.status, 0, run.gate.stdout);
        // Nothing reaches a green gate through a skip the failed classifier
        // cannot justify.
        for (const job of ['docs', 'native-electron']) {
            const forced = simulateRun({ classifier: 'failure', results: { [job]: 'failure' } });
            assert.equal(forced.gate.status, 1, job);
        }
    });

    test('a cancelled run is never reported green', () => {
        const run = simulateRun({ classifier: 'cancelled', cancelled: true });
        assert.equal(run.gateRuns, true, 'the gate still runs and fails a cancelled run closed');
        assert.equal(run.gate.status, 1);
    });

    test('manual dispatch never consults the classifier and runs everything', () => {
        const run = simulateRun({ eventName: 'workflow_dispatch', classifier: narrowDecision(PR_2513) });
        assert.equal(run.needs.classify.result, 'skipped');
        assert.deepEqual(run.started, { shard: true, docs: true, 'native-electron': true });
        assert.equal(run.gate.status, 0, run.gate.stdout);
        // The classifier itself never narrows a non-pull-request event.
        for (const eventName of ['workflow_dispatch', 'schedule', 'push']) {
            const decision = classifyChanges({ files: [{ status: 'M', path: 'src/jobs/reviewOutputParser.ts' }], eventName });
            assert.equal(decision.broad, true, eventName);
            assert.equal(decision.surfaces.docs && decision.surfaces.desktop, true, eventName);
        }
    });

    test('scheduled full validation stays comprehensive and outside the classifier', () => {
        const trigger = fullSuite.slice(fullSuite.indexOf('on:'), fullSuite.indexOf('concurrency:'));
        assert.doesNotMatch(trigger, /schedule:/, 'no schedule is added to the full suite');
        const nightly = readWorkflow('test-nightly.yml');
        assert.match(nightly, /schedule:/);
        assert.doesNotMatch(nightly, /classify/, 'the nightly suite is never narrowed');
    });

    test('draft pull requests start nothing, as before', () => {
        const run = simulateRun({ draft: true, classifier: narrowDecision(['docs/docs/intro.md']) });
        assert.equal(run.needs.classify.result, 'skipped');
        assert.deepEqual(run.started, { shard: false, docs: false, 'native-electron': false });
        assert.equal(run.gateRuns, false);
    });

    test('backend shards and their coverage invariant never depend on the classifier', () => {
        const shard = jobBlock(fullSuite, 'shard');
        assert.deepEqual(jobNeeds(shard), []);
        assert.doesNotMatch(shard, /classify/);
        assert.equal(jobCondition(shard), "${{ github.event_name == 'workflow_dispatch' || !github.event.pull_request.draft }}");
        assert.match(shard, /\n\s+npm ci\n|run: npm ci\n/, 'every shard installs dependencies');
        assert.match(shard, /npm run test:prepare\n/, 'every shard enforces test preparation');
        assert.match(fullSuite, /PROPR_TEST_SHARD_COUNT: '4'\n/);
        assert.match(jobBlock(fullSuite, 'test'), /node scripts\/run-test-suite\.mjs --verify-shard-summaries/);
        // Every classifier outcome, including failure, starts all four shards.
        for (const classifier of [narrowDecision(PR_2513), narrowDecision(['docs/docs/intro.md']), 'failure']) {
            assert.equal(simulateRun({ classifier }).started.shard, true);
        }
    });

    test('gated jobs skip only on an explicit false and keep run cancellation', () => {
        for (const [job, surface] of [['docs', 'docs'], ['native-electron', 'desktop']]) {
            const condition = jobCondition(jobBlock(fullSuite, job));
            assert.ok(condition.includes(`needs.classify.outputs.${surface} != 'false'`), job);
            assert.ok(!condition.includes(`needs.classify.outputs.${surface} == 'true'`), job);
            assert.ok(condition.startsWith('${{ !cancelled() &&'), job);
            assert.deepEqual(jobNeeds(jobBlock(fullSuite, job)), ['classify']);
        }
        const classify = jobBlock(fullSuite, 'classify');
        assert.match(classify, /uses: \.\/\.github\/actions\/classify-changes\n/);
        assert.match(classify, /fetch-depth: 0\n/);
        assert.match(classify, /persist-credentials: false\n/);
        assert.match(classify, /permissions:\n\s+contents: read\n\s+outputs:/);
        assert.match(classify, /\n {4}runs-on: ubuntu-latest\n/);
    });
});

// --- required gate ----------------------------------------------------------

describe('Run Full Test Suite gate', () => {
    const narrow = {
        EVENT_NAME: 'pull_request',
        CLASSIFY_RESULT: 'success',
        CLASSIFY_STATUS: 'ok',
        CLASSIFY_BROAD: 'false',
        DOCS_DECISION: 'false',
        DESKTOP_DECISION: 'false',
        SHARD_RESULT: 'success',
        DOCS_RESULT: 'skipped',
        ELECTRON_RESULT: 'skipped',
        COVERAGE_RESULT: 'success',
    };

    test('accepts intentional surface skips', () => {
        const passed = runGate(narrow);
        assert.equal(passed.status, 0, passed.stdout);
    });

    test('the gate receives every value it judges from the workflow', () => {
        const step = jobBlock(fullSuite, 'test');
        const environment = expressionMap(step.slice(step.indexOf('- name: Enforce shard and docs results')), '\n        env:\n');
        assert.deepEqual(Object.keys(environment).sort(), Object.keys(narrow).sort());
        assert.deepEqual(jobNeeds(step), ['classify', 'shard', 'docs', 'native-electron']);
    });

    for (const [label, change] of [
        ['a skip without a false decision', { DOCS_DECISION: 'true' }],
        ['a skip with a missing decision', { DESKTOP_DECISION: '' }],
        ['a skip after a fallback classification', { CLASSIFY_STATUS: 'fallback' }],
        ['a skip after a broad classification', { CLASSIFY_BROAD: 'true' }],
        ['a skip after a failed classifier job', { CLASSIFY_RESULT: 'failure' }],
        ['a skip after a cancelled classifier job', { CLASSIFY_RESULT: 'cancelled' }],
        ['a skip after a skipped classifier job', { CLASSIFY_RESULT: 'skipped' }],
        ['a skip on manual dispatch', { EVENT_NAME: 'workflow_dispatch' }],
        ['a skip on a scheduled run', { EVENT_NAME: 'schedule' }],
        ['a docs failure', { DOCS_DECISION: 'true', DOCS_RESULT: 'failure' }],
        ['a docs cancellation', { DOCS_DECISION: 'true', DOCS_RESULT: 'cancelled' }],
        ['a native Electron failure', { DESKTOP_DECISION: 'true', ELECTRON_RESULT: 'failure' }],
        ['a native Electron cancellation', { DESKTOP_DECISION: 'true', ELECTRON_RESULT: 'cancelled' }],
        ['a missing native Electron result', { ELECTRON_RESULT: '' }],
        ['a failed shard', { SHARD_RESULT: 'failure' }],
        ['a cancelled shard', { SHARD_RESULT: 'cancelled' }],
        ['skipped shards', { SHARD_RESULT: 'skipped' }],
        ['a missing shard result', { SHARD_RESULT: '' }],
        ['a missing shard summary or coverage evidence', { COVERAGE_RESULT: 'failure' }],
        ['coverage verification that did not run', { COVERAGE_RESULT: '' }],
    ]) {
        test(`fails on ${label}`, () => {
            const failed = runGate({ ...narrow, ...change });
            assert.equal(failed.status, 1, failed.stdout);
            assert.match(failed.stdout, /::error::/);
        });
    }

    test('an explicit false never excuses a job that ran and failed', () => {
        assert.equal(runGate({ ...narrow, DOCS_RESULT: 'failure' }).status, 1);
        assert.equal(runGate({ ...narrow, ELECTRON_RESULT: 'failure' }).status, 1);
        assert.equal(runGate({ ...narrow, DOCS_RESULT: 'success', ELECTRON_RESULT: 'success' }).status, 0);
    });
});

// --- dependency audit -------------------------------------------------------

// `./x`, `../x`, and a bare sibling script name such as the fixture a unit
// passes to `resolve(dirname(...), 'electron-pairing-zstd-probe.cjs')`.
const RELATIVE_SPECIFIER = /['"](\.\.?\/[^'"\s]+|[\w.-]+\.(?:mjs|cjs|js))['"]/g;

/** Repository paths a source file names through a relative string literal. */
function relativeReferences(path) {
    const source = readFileSync(join(REPOSITORY, path), 'utf8');
    return [...source.matchAll(RELATIVE_SPECIFIER)]
        .map(match => posix.normalize(posix.join(posix.dirname(path), match[1])));
}

function workspacePackages() {
    const packages = new Map();
    for (const entry of readdirSync(join(REPOSITORY, 'packages'))) {
        const manifest = join(REPOSITORY, 'packages', entry, 'package.json');
        if (existsSync(manifest)) packages.set(JSON.parse(readFileSync(manifest, 'utf8')).name, `packages/${entry}`);
    }
    return packages;
}

describe('gated job inputs are covered by their surface', () => {
    test('everything the native Electron units load selects the desktop surface', () => {
        const run = extractRunBlock(jobBlock(fullSuite, 'native-electron'), 'Run native Electron units without skipping');
        const units = spawnSync('bash', ['-c', `${run.split('\n').filter(line => line.startsWith('mapfile')).join('\n')}\nprintf '%s\\n' "\${files[@]}"`], {
            cwd: REPOSITORY,
            encoding: 'utf8',
        }).stdout.trim().split('\n');
        assert.ok(units.length >= 2, 'native Electron units were discovered');

        // Follow relative references transitively through the desktop scripts,
        // and record which workspace packages' build output they load.
        const inputs = new Set(units);
        const pending = [...units];
        const packagesLoaded = new Set();
        while (pending.length > 0) {
            for (const reference of relativeReferences(pending.pop())) {
                const built = reference.match(/^(packages\/[^/]+)\/dist\//);
                if (built) {
                    packagesLoaded.add(built[1]);
                    continue;
                }
                if (inputs.has(reference) || !/\.(mjs|cjs|js)$/.test(reference)) continue;
                if (!existsSync(join(REPOSITORY, reference))) continue;
                inputs.add(reference);
                pending.push(reference);
            }
        }
        assert.ok(packagesLoaded.has('packages/client'), 'the zstd probe loads @propr/client output');

        // A loaded package's own workspace dependencies are inputs too.
        const byName = workspacePackages();
        for (const directory of [...packagesLoaded]) {
            const manifest = JSON.parse(readFileSync(join(REPOSITORY, directory, 'package.json'), 'utf8'));
            for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
                if (byName.has(name)) packagesLoaded.add(byName.get(name));
            }
        }
        assert.ok(packagesLoaded.has('packages/shared'), '@propr/client depends on @propr/shared');

        const paths = [
            ...inputs,
            ...[...packagesLoaded].map(directory => `${directory}/src/index.ts`),
            // The runner the job invokes.
            'scripts/run-test-suite.mjs',
        ];
        for (const path of paths) {
            const decision = narrowDecision([path]);
            assert.ok(decision.broad || decision.surfaces.desktop, `${path} must select the desktop surface`);
        }
    });

    test('the docs site reads nothing from outside docs/', () => {
        const files = execFileSync('git', ['-C', REPOSITORY, 'ls-files', '--', 'docs'], { encoding: 'utf8' })
            .trim().split('\n')
            .filter(path => /\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|json|css)$/.test(path));
        assert.ok(files.includes('docs/docusaurus.config.ts'));
        for (const path of files) {
            for (const reference of relativeReferences(path)) {
                // Normalising a path that climbs out of docs/ is the only way
                // a reference can leave it.
                assert.ok(reference.startsWith('docs/'), `${path} reads ${reference}, outside the docs surface`);
            }
        }
        for (const path of files) {
            const decision = narrowDecision([path]);
            assert.ok(decision.broad || decision.surfaces.docs, `${path} must select the docs surface`);
        }
    });

    test('the docs job\'s other inputs are broad', () => {
        const docs = jobBlock(fullSuite, 'docs');
        assert.match(docs, /run: \.\/\.propr\/setup\.sh\n/);
        const setup = readFileSync(join(REPOSITORY, '.propr', 'setup.sh'), 'utf8');
        // The script leaves the repository root only for the docs site, and
        // its Chromium comes from the UI workspace's pinned Playwright.
        assert.deepEqual([...setup.matchAll(/^\s*cd (.+)$/gm)].map(match => match[1]), ['"$WORKSPACE"', '"$WORKSPACE/docs"']);
        assert.match(setup, /npm exec --workspace propr-ui -- playwright install chromium/);
        for (const path of ['.propr/setup.sh', 'docs/package-lock.json', 'propr-ui/package-lock.json', '.nvmrc']) {
            assert.equal(narrowDecision([path]).broad, true, path);
        }
    });
});
