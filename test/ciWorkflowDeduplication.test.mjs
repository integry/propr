import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { planRun, unitKey } from '../scripts/run-test-suite.mjs';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const rootPackage = JSON.parse(readFileSync(join(REPOSITORY, 'package.json'), 'utf8'));
const readWorkflow = name => readFileSync(join(REPOSITORY, '.github', 'workflows', name), 'utf8');
const buildCheck = readWorkflow('pr-build-check.yml');
const fullSuite = readWorkflow('pr-test-on-label.yml');
// Comments in these workflows name the scripts they deliberately no longer
// run, so the "is it still invoked" checks below read commands only.
const buildCheckCommands = buildCheck.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');

function listFiles(directory, root = directory, found = []) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) listFiles(path, root, found);
        else found.push(relative(root, path).replaceAll('\\', '/'));
    }
    return found;
}

const uiFiles = listFiles(join(REPOSITORY, 'propr-ui'));

const TEST_FILE_ARGUMENT = /^[\w./@-]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const namedTestFiles = script => script.split(/\s+/).filter(token => TEST_FILE_ARGUMENT.test(token));

// The focused server-side suites that no longer run as their own CI step. Each
// entry is a package script kept for local use; the full suite is what now
// enforces it on a pull request.
const DEDUPLICATED_SERVER_SUITES = [
    'test:unit',
    'test:mcp',
    'test:mcp:browser',
    'test:notifications:server',
    'test:visual-previews:server',
    'test:hosted-tunnel:server',
];

// Their propr-ui halves. propr-ui is a native vitest workspace, so the full
// suite runs it as four `--shard` parts that together cover every file.
const DEDUPLICATED_UI_SUITES = ['test:notifications:ui', 'test:visual-previews:ui', 'test:hosted-tunnel:ui'];

const plan = planRun({});
const discovered = new Set(plan.allUnits.map(unitKey));

describe('full-suite coverage of the deduplicated build-check suites', () => {
    test('every focused server suite names only files the full suite discovers', () => {
        for (const script of DEDUPLICATED_SERVER_SUITES) {
            const files = namedTestFiles(rootPackage.scripts[script]);
            assert.ok(files.length > 0, `${script} names test files`);
            for (const file of files) {
                assert.ok(existsSync(join(REPOSITORY, file)), `${script}: ${file} exists`);
                assert.ok(discovered.has(`file:${file}`), `${script}: ${file} is a discovered full-suite unit`);
            }
        }
    });

    test('every focused UI suite names propr-ui files the workspace parts cover', () => {
        const parts = plan.allUnits.filter(unit => unit.kind === 'workspace' && unit.workspace === 'propr-ui');
        assert.equal(parts.length, 4, 'propr-ui runs as four workspace parts');

        const vitestConfig = readFileSync(join(REPOSITORY, 'propr-ui', 'vite.config.ts'), 'utf8');
        const excluded = vitestConfig.slice(vitestConfig.indexOf('exclude:'), vitestConfig.indexOf('\n', vitestConfig.indexOf('exclude:')));
        for (const script of DEDUPLICATED_UI_SUITES) {
            const files = namedTestFiles(rootPackage.scripts[script]);
            assert.ok(files.length > 0, `${script} names test files`);
            for (const file of files) {
                // vitest takes trailing arguments as filename filters, so a
                // focused suite may name a path or just a file name.
                const matches = uiFiles.filter(candidate => candidate === file || candidate.endsWith(`/${file}`));
                assert.ok(matches.length > 0, `${script}: ${file} resolves inside propr-ui`);
                for (const match of matches) {
                    assert.ok(!excluded.includes(match), `${script}: ${match} is not excluded from vitest discovery`);
                    assert.ok(!match.startsWith('e2e/'), `${script}: ${match} is a vitest file, not a Playwright spec`);
                }
            }
        }
    });

    test('the removed suites are no longer invoked by the build check', () => {
        for (const script of [...DEDUPLICATED_SERVER_SUITES, ...DEDUPLICATED_UI_SUITES, 'test:notifications', 'test:visual-previews']) {
            assert.ok(!buildCheckCommands.includes(`npm run ${script}`), `pr-build-check.yml still runs ${script}`);
        }
        // The hosted tunnel step used to inline its file list here.
        assert.ok(!buildCheckCommands.includes('orchestratorTunnelLifecycle.test.mjs'));
        assert.ok(!buildCheckCommands.includes('npm run test:prepare'), 'no full workspace build is left without a consumer');
    });

    test('the focused suites stay available to developers', () => {
        for (const script of [...DEDUPLICATED_SERVER_SUITES, ...DEDUPLICATED_UI_SUITES, 'test:notifications', 'test:visual-previews', 'test:hosted-tunnel']) {
            assert.equal(typeof rootPackage.scripts[script], 'string', script);
        }
    });

    test('the full suite is the enforcing gate and runs for every pull request', () => {
        const trigger = fullSuite.slice(fullSuite.indexOf('on:'), fullSuite.indexOf('concurrency:'));
        assert.match(trigger, /pull_request:\n\s+types: \[opened, synchronize, reopened, ready_for_review\]\n/);
        assert.ok(!trigger.includes('paths:'), 'no path filter may hide the gate that now owns these assertions');
        assert.match(fullSuite, /name: Run Full Test Suite\n/);
        assert.match(fullSuite, /npm run test:full:prepared/);
    });
});

describe('assertions the build check must keep', () => {
    test('Playwright browser specs exist nowhere in full-suite discovery', () => {
        const specs = ['task-details-visual-previews.pw.ts', 'mobile-install.smoke.pw.ts', 'settings-notification-routing.pw.ts'];
        for (const spec of specs) {
            assert.ok(existsSync(join(REPOSITORY, 'propr-ui', 'e2e', spec)), spec);
            assert.ok(!discovered.has(`file:propr-ui/e2e/${spec}`), `${spec} is not a full-suite unit`);
        }
        assert.ok(![...discovered].some(id => id.endsWith('.pw.ts')), 'no Playwright spec is discovered');
    });

    test('the PWA and mobile browser smoke test still runs in the build check', () => {
        assert.match(buildCheck, /\n\s+npm run test:browser --workspace=propr-ui\n/);
        // The UI build needs @propr/shared; reuse it when it is already there.
        assert.match(buildCheck, /test -f packages\/shared\/dist\/index\.js \|\| npm run build -w @propr\/shared\n/);
        assert.equal(buildCheck.split('./scripts/ci-install-chromium.sh').length - 1, 1,
            'exactly one Chromium install remains, for the browser smoke test');
        // The shared classifier decides this now, and a decision is only ever
        // read as "skip" when it is an explicit false.
        assert.match(buildCheck, /- name: Install Chromium for PWA Smoke Test\n(\s+#[^\n]*\n)*\s+if: steps\.filter\.outputs\.ui != 'false'\n/);
    });

    test('packaging, release metadata and workflow linting still run in the build check', () => {
        assert.match(buildCheck, /npm run cli:pack\n/);
        assert.match(buildCheck, /npm run release:verify\n/);
        assert.match(buildCheck, /ACTIONLINT_IMAGE:/);
        assert.match(buildCheck, /--entrypoint shellcheck/);
    });

    test('the changed-area gate still fails the check closed', () => {
        assert.match(buildCheck, /- name: Fail Job\n\s+if: steps\.build\.outcome == 'failure'\n\s+run: exit 1\n/);
    });
});

describe('redundant work removed inside the build check job', () => {
    test('the changed-area checks reuse this job own verified workspace builds', () => {
        const validate = buildCheck.slice(buildCheck.indexOf('\n  validate:\n'));
        const recorded = validate.indexOf('echo "PROPR_CLI_WORKSPACE_DIST_READY=1" >> "$GITHUB_ENV"');
        assert.ok(recorded >= 0, 'the CLI packaging step records its successful workspace builds');
        for (const [workspace, output] of [['shared', 'SHARED_BUILT'], ['local-setup', 'LOCAL_SETUP_BUILT']]) {
            const reused = validate.indexOf(
                `if [ "\${PROPR_CLI_WORKSPACE_DIST_READY:-}" = '1' ] && [ -f packages/${workspace}/dist/index.js ]; then`);
            assert.ok(reused > recorded, `${workspace} reuse is consulted after the recording step`);
            // Reuse is refused unless the built file is really there, so a
            // cleaned or partial workspace falls back to building it again.
            assert.match(validate.slice(reused), new RegExp(`^\\s*${output}=1\\n`, 'm'));
        }
        assert.match(validate, /build_shared_once\(\) \{\n\s+if \[ \$SHARED_BUILT -eq 1 \]; then\n/);
        assert.match(validate, /build_local_setup_once\(\) \{\n\s+if \[ \$LOCAL_SETUP_BUILT -eq 1 \]; then\n/);
        // packages/api imports @propr/local-setup through its published types,
        // so the root build cannot run before that output exists.
        const core = validate.slice(validate.indexOf('# --- CORE ---'));
        assert.ok(core.indexOf('build_local_setup_once') < core.indexOf('npm run build 2>&1'));
    });

    test('nothing carries a build between jobs, runners or commits', () => {
        for (const workflow of [buildCheck, fullSuite]) {
            assert.ok(!/actions\/cache@/.test(workflow), 'no build output cache is introduced');
            assert.ok(!/clean: false/.test(workflow), 'every checkout stays clean');
        }
        assert.match(fullSuite, /test ! -e packages\/shared\/dist\n\s+test ! -e packages\/client\/dist\n/);
    });
});
