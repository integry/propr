import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import {
    CONNECT_PROOF_FILES,
    NARROW_ROOT_TEST_SCRIPTS,
    SURFACES,
    ON_DEMAND_SURFACES,
    DESKTOP_CI_LABEL,
    lockfileAffectsDesktop,
    pullRequestLabels,
    classifyChanges,
    classifyManifest,
    classifyRepository,
    renderSummary,
} from '../scripts/ci-change-classification.mjs';

const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const CLASSIFIER = join(REPOSITORY, 'scripts', 'ci-change-classification.mjs');
const ROOT_PACKAGE = JSON.parse(readFileSync(join(REPOSITORY, 'package.json'), 'utf8'));
const readWorkflow = name => readFileSync(join(REPOSITORY, '.github', 'workflows', name), 'utf8');

const scratch = mkdtempSync(join(tmpdir(), 'propr-ci-classification-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let scratchCounter = 0;
const freshDirectory = (name) => {
    scratchCounter += 1;
    const directory = join(scratch, `${String(scratchCounter).padStart(2, '0')}-${name}`);
    mkdirSync(directory, { recursive: true });
    return directory;
};

const changed = (paths, status = 'M') => paths.map(path => ({ status, path }));
const selected = decision => SURFACES.filter(surface => decision.surfaces[surface]);
const classifyPaths = (paths, options = {}) =>
    classifyChanges({ files: changed(paths), ...options });

const serialize = value => JSON.stringify(value, null, 2);
const manifestPair = (base, head) => ({ 'package.json': { base: serialize(base), head: serialize(head) } });
const rootManifest = () => JSON.parse(JSON.stringify(ROOT_PACKAGE));

// --- git fixtures -----------------------------------------------------------

const git = (directory, args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();

function newRepository(name) {
    const directory = freshDirectory(name);
    git(directory, ['init', '--quiet', '--initial-branch=main']);
    git(directory, ['config', 'user.email', 'ci@example.com']);
    git(directory, ['config', 'user.name', 'Propr CI']);
    git(directory, ['config', 'commit.gpgsign', 'false']);
    return directory;
}

function writeFiles(directory, files) {
    for (const [path, contents] of Object.entries(files)) {
        const absolute = join(directory, path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, contents);
    }
}

function commit(directory, files, message, { removed = [] } = {}) {
    writeFiles(directory, files);
    for (const path of removed) git(directory, ['rm', '--quiet', '--', path]);
    git(directory, ['add', '--all']);
    git(directory, ['commit', '--quiet', '--allow-empty', '-m', message]);
    return git(directory, ['rev-parse', 'HEAD']);
}

/** A repository with one base commit and a branch, both fully materialised. */
function repositoryWithBranch(name) {
    const directory = newRepository(name);
    const base = commit(directory, {
        'package.json': `${serialize(ROOT_PACKAGE)}\n`,
        'packages/api/mcp/server.ts': 'export const server = 1;\n',
        'docs/index.md': '# docs\n',
    }, 'base');
    git(directory, ['checkout', '--quiet', '-b', 'feature']);
    return { directory, base };
}

// --- path policy ------------------------------------------------------------

describe('path classification', () => {
    test('the #2501 change set selects only the API surface', () => {
        const head = rootManifest();
        head.scripts['test:mcp'] = `${head.scripts['test:mcp']} packages/api/test/mcpActivity.test.ts`;
        const decision = classifyPaths([
            'packages/api/mcp/activityDigest.ts',
            'packages/api/mcp/presentation.ts',
            'packages/api/mcp/server.ts',
            'packages/api/mcp/tools.ts',
            'packages/api/mcp/toolsActivity.ts',
            'packages/api/test/fixtures/mcpActivity.ts',
            'packages/api/test/mcpActivity.test.ts',
            'packages/api/test/mcpConnectIntegration.test.ts',
            'packages/api/test/mcpIntegration.test.ts',
            'package.json',
        ], { manifests: manifestPair(ROOT_PACKAGE, head) });

        assert.equal(decision.status, 'ok');
        assert.equal(decision.broad, false);
        assert.deepEqual(selected(decision), ['api']);
        assert.equal(decision.surfaces.desktop, false);
        assert.equal(decision.surfaces.cli, false);
        assert.equal(decision.surfaces.connect, false);
        assert.equal(decision.surfaces.ui, false);
        assert.equal(decision.surfaces.docs, false);
        // Every decision carries a readable reason for the path that drove it.
        const manifestReason = decision.reasons.find(reason => reason.path === 'package.json');
        assert.match(manifestReason.detail, /only known backend test scripts changed: test:mcp/);
    });

    test('API and MCP sources without a manifest select only the API surface', () => {
        const decision = classifyPaths([
            'packages/api/mcp/server.ts',
            'packages/api/test/mcpIntegration.test.ts',
        ]);
        assert.deepEqual(selected(decision), ['api']);
    });

    test('API implementation also selects the Connect proofs', () => {
        const decision = classifyPaths(['packages/api/src/routes/status.ts']);
        assert.deepEqual(selected(decision).sort(), ['api', 'connect']);
    });

    test('shared runtime, client, CLI, renderer and desktop changes activate downstream consumers', () => {
        // Shared runtime and renderer changes leave the packaged desktop app to the nightly run.
        assert.equal(classifyPaths(['packages/shared/src/index.ts']).surfaces.desktop, false);
        assert.equal(classifyPaths(['packages/shared/src/index.ts']).surfaces.ui, true);
        assert.equal(classifyPaths(['packages/shared/src/index.ts']).surfaces.api, true);
        assert.deepEqual(selected(classifyPaths(['packages/client/src/index.ts'])).sort(),
            ['connect', 'desktop', 'ui']);
        assert.deepEqual(selected(classifyPaths(['packages/cli/src/index.ts'])).sort(),
            ['cli', 'connect', 'desktop']);
        assert.deepEqual(selected(classifyPaths(['packages/local-setup/src/index.ts'])).sort(),
            ['cli', 'connect', 'desktop']);
        assert.deepEqual(selected(classifyPaths(['propr-ui/src/App.tsx'])), ['ui']);
        assert.deepEqual(selected(classifyPaths(['apps/desktop/src/main.ts'])), ['desktop']);
        assert.deepEqual(selected(classifyPaths(['docs/guide.md'])), ['docs']);
        assert.deepEqual(selected(classifyPaths(['src/worker.ts'])), ['core']);
    });

    test('@propr/core sources are reported for the changed-source lint', () => {
        const decision = classifyChanges({
            files: [
                { status: 'M', path: 'packages/core/src/service.ts' },
                { status: 'D', path: 'packages/core/src/removed.ts' },
                { status: 'A', path: 'packages/core/test/service.test.ts' },
            ],
        });
        assert.equal(decision.core_package_source, true);
        assert.deepEqual(decision.core_package_source_files, ['packages/core/src/service.ts']);
    });

    // Broad changes validate every surface except the on-demand desktop checks,
    // which run only when the change defines them (or cannot be ruled out).
    for (const [path, why, desktop] of [
        ['.github/workflows/pr-build-check.yml', 'workflow', false],
        ['.github/workflows/desktop-release-guard.yml', 'desktop workflow', true],
        ['.github/workflows/desktop-connect-discovery-guard.yml', 'desktop workflow', true],
        ['.github/workflows/pr-test-on-label.yml', 'the workflow hosting the native Electron job', true],
        ['.github/actions/classify-changes/action.yml', 'composite action', true],
        ['scripts/ci-change-classification.mjs', 'the classifier itself', true],
        ['test/ciChangeClassification.test.mjs', 'the classifier test', false],
        ['package-lock.json', 'unreadable lockfile', true],
        ['propr-ui/package-lock.json', 'unreadable workspace lockfile', true],
        ['.nvmrc', 'toolchain', false],
        ['tsconfig.json', 'shared toolchain configuration', false],
        ['eslint.config.js', 'shared toolchain configuration', false],
        ['Dockerfile.agent', 'image definition', false],
        ['docker-compose.yml', 'compose stack', false],
        ['.propr/setup.sh', 'repository automation', false],
        ['config/anything.json', 'deployment configuration', false],
        ['apps/some-new-app/index.ts', 'an unrecognised application', false],
        ['weird/unknown.txt', 'an unrecognised path', false],
        ['packages/brand-new/index.ts', 'an unrecognised workspace', false],
    ]) {
        test(`${why} change (${path}) selects every surface${desktop ? '' : ' except desktop'}`, () => {
            const decision = classifyPaths([path]);
            assert.equal(decision.broad, true, `${path} must be broad`);
            assert.deepEqual(selected(decision), SURFACES.filter(surface => desktop || !ON_DEMAND_SURFACES.includes(surface)));
        });
    }

    test('an empty or malformed change set selects every surface', () => {
        assert.equal(classifyChanges({ files: [] }).broad, true);
        assert.equal(classifyChanges({}).broad, true);
        assert.equal(classifyChanges({ files: [{ status: 'M', path: '' }] }).broad, true);
        assert.equal(classifyChanges({ files: [{ status: 'M' }] }).broad, true);
    });

    test('events other than pull_request select every surface', () => {
        for (const eventName of ['workflow_dispatch', 'push', 'schedule']) {
            const decision = classifyChanges({
                files: changed(['packages/api/mcp/server.ts']),
                eventName,
            });
            assert.equal(decision.broad, true, eventName);
            assert.deepEqual(selected(decision), [...SURFACES]);
        }
    });

    test('every file the Connect proof scripts run selects the Connect surface', () => {
        const proofScripts = [
            'scripts/verify-platform-safe-connect.mjs',
            'scripts/verify-native-connect-authority.mjs',
        ].map(name => readFileSync(join(REPOSITORY, name), 'utf8'));
        const named = new Set();
        for (const source of proofScripts) {
            for (const match of source.matchAll(/["']((?:packages|test|apps)\/[\w./-]+\.(?:m?[jt]s|tsx))["']/g)) {
                named.add(match[1]);
            }
            // `join(root, "test", "file.ts")` style references.
            for (const match of source.matchAll(/join\(root,\s*"([\w.-]+)",\s*"([\w.-]+)"\)/g)) {
                named.add(`${match[1]}/${match[2]}`);
            }
        }
        assert.ok(named.size >= 8, `expected to find the proof inputs, found ${named.size}`);
        for (const path of named) {
            const decision = classifyPaths([path]);
            assert.equal(decision.surfaces.connect, true,
                `${path} is run by a Connect proof and must select the connect surface`);
        }
        for (const path of CONNECT_PROOF_FILES) {
            assert.ok(named.has(path), `${path} is listed as a Connect proof input but no script runs it`);
        }
    });
});

// --- manifest policy --------------------------------------------------------

describe('manifest classification', () => {
    const classifyRoot = (mutate, { status = 'M', path = 'package.json' } = {}) => {
        const base = rootManifest();
        const head = rootManifest();
        mutate(head, base);
        return classifyManifest({
            path,
            status,
            baseText: serialize(base),
            headText: serialize(head),
        });
    };

    test('a change confined to a known backend test script is narrow', () => {
        const result = classifyRoot(head => {
            head.scripts['test:mcp'] = `${head.scripts['test:mcp']} packages/api/test/mcpActivity.test.ts`;
        });
        assert.equal(result.broad, false);
        assert.deepEqual(result.surfaces, ['api']);
    });

    test('the narrow scripts exist and no workflow invokes them', () => {
        const workflowCommands = ['pr-build-check.yml', 'pr-test-on-label.yml', 'cli-node-compatibility.yml',
            'desktop-release-guard.yml', 'desktop-connect-discovery-guard.yml', 'test-nightly.yml']
            .map(readWorkflow)
            .map(workflow => workflow.split('\n').filter(line => !/^\s*#/.test(line)).join('\n'))
            .join('\n');
        for (const name of Object.keys(NARROW_ROOT_TEST_SCRIPTS)) {
            assert.ok(Object.hasOwn(ROOT_PACKAGE.scripts, name),
                `${name} must exist in the root manifest`);
            assert.ok(!workflowCommands.includes(`run ${name}`),
                `${name} is invoked by a workflow, so editing it cannot be classified narrowly`);
        }
    });

    test('whitespace and key order alone are not a change', () => {
        const base = rootManifest();
        const reordered = Object.fromEntries(Object.entries(base).reverse());
        const result = classifyManifest({
            path: 'package.json',
            status: 'M',
            baseText: JSON.stringify(base, null, 4),
            headText: JSON.stringify(reordered),
        });
        assert.equal(result.broad, false);
        assert.deepEqual(result.surfaces, []);
        assert.match(result.detail, /whitespace or key order/);

        const decision = classifyPaths(['package.json', 'packages/api/mcp/server.ts'], {
            manifests: { 'package.json': { base: JSON.stringify(base, null, 4), head: JSON.stringify(reordered) } },
        });
        assert.deepEqual(selected(decision), ['api']);
    });

    for (const [name, mutate] of [
        ['a runtime dependency', head => { head.dependencies = { ...head.dependencies, left: '1.0.0' }; }],
        ['a dev dependency', head => { head.devDependencies = { ...head.devDependencies, left: '1.0.0' }; }],
        ['an optional dependency', head => { head.optionalDependencies = { left: '1.0.0' }; }],
        ['a peer dependency', head => { head.peerDependencies = { left: '1.0.0' }; }],
        ['an override', head => { head.overrides = { ...head.overrides, left: '1.0.0' }; }],
        ['a resolution', head => { head.resolutions = { left: '1.0.0' }; }],
        ['engines', head => { head.engines = { ...head.engines, node: '>=99' }; }],
        ['packageManager', head => { head.packageManager = 'npm@11.0.0'; }],
        ['workspaces', head => { head.workspaces = [...head.workspaces, 'packages/new']; }],
        ['version', head => { head.version = '99.0.0'; }],
        ['an unrecognised field', head => { head.frobnicate = true; }],
        ['the build script', head => { head.scripts.build = 'tsc --incremental'; }],
        ['a lifecycle script', head => { head.scripts.postinstall = 'node scripts/x.mjs'; }],
        ['a pre-script', head => { head.scripts['pretest:unit'] = 'echo changed'; }],
        ['a package script', head => { head.scripts['cli:pack'] = 'npm pack'; }],
        ['a new unknown script', head => { head.scripts['test:brand-new'] = 'node --test'; }],
        ['a narrow script together with a dependency', head => {
            head.scripts['test:mcp'] = `${head.scripts['test:mcp']} more.test.ts`;
            head.dependencies = { ...head.dependencies, left: '1.0.0' };
        }],
    ]) {
        test(`changing ${name} selects every surface`, () => {
            const result = classifyRoot(mutate);
            assert.equal(result.broad, true, `${name} must be broad: ${result.detail}`);
        });
    }

    test('added, deleted, renamed, malformed and unavailable manifests select every surface', () => {
        const text = serialize(ROOT_PACKAGE);
        for (const status of ['A', 'D', 'R100', 'C90', 'T']) {
            assert.equal(classifyManifest({ path: 'package.json', status, baseText: text, headText: text }).broad,
                true, status);
        }
        assert.equal(classifyManifest({
            path: 'package.json', status: 'M', baseText: '{ not json', headText: text,
        }).broad, true);
        assert.equal(classifyManifest({
            path: 'package.json', status: 'M', baseText: text, headText: '{ not json',
        }).broad, true);
        assert.equal(classifyManifest({
            path: 'package.json', status: 'M', baseText: null, headText: text,
        }).broad, true);
        assert.equal(classifyManifest({
            path: 'package.json', status: 'M', baseText: '[]', headText: '[]',
        }).broad, true);
        assert.equal(classifyManifest({
            path: 'package.json', status: 'M', baseText: '{"scripts":{"test:mcp":"a"}}', headText: '{"scripts":"no"}',
        }).broad, true);
    });

    test('workspace manifest script changes are not narrowed', () => {
        const base = { name: '@propr/desktop', scripts: { 'test:mcp': 'node --test' } };
        const head = { name: '@propr/desktop', scripts: { 'test:mcp': 'node --test extra.ts' } };
        const result = classifyManifest({
            path: 'apps/desktop/package.json',
            status: 'M',
            baseText: serialize(base),
            headText: serialize(head),
        });
        assert.equal(result.broad, true);
        assert.match(result.detail, /workspace manifest/);
    });

    test('a manifest with no recorded contents selects every surface', () => {
        const decision = classifyPaths(['package.json']);
        assert.equal(decision.broad, true);
    });
});

// --- on-demand desktop surface ---------------------------------------------

describe('on-demand desktop checks', () => {
    const lockfile = packages => serialize({ name: 'propr', lockfileVersion: 3, packages });

    test('the desktop-ci label selects the desktop checks for any change', () => {
        const decision = classifyChanges({ files: changed(['propr-ui/src/App.tsx']), labels: [DESKTOP_CI_LABEL] });
        assert.deepEqual(selected(decision).sort(), ['desktop', 'ui']);
        assert.ok(decision.reasons.some(reason => reason.detail.includes(DESKTOP_CI_LABEL)));
        assert.equal(classifyChanges({ files: changed(['propr-ui/src/App.tsx']), labels: ['bug'] }).surfaces.desktop, false);
    });

    test('a lockfile change selects the desktop checks only when desktop dependencies change', () => {
        const base = { '': { name: 'propr' }, 'node_modules/react': { version: '19.0.0' }, 'node_modules/electron': { version: '38.0.0' }, 'apps/desktop': { dependencies: { a: '1' } } };
        const unrelated = { ...base, 'node_modules/react': { version: '19.1.0' } };
        const electron = { ...base, 'node_modules/electron': { version: '38.1.0' } };
        const desktopDependency = { ...base, 'apps/desktop': { dependencies: { a: '2' } } };
        const scoped = { ...base, 'node_modules/@electron/get': { version: '4.0.0' } };
        assert.equal(lockfileAffectsDesktop(lockfile(base), lockfile(unrelated)), false);
        assert.equal(lockfileAffectsDesktop(lockfile(base), lockfile(electron)), true);
        assert.equal(lockfileAffectsDesktop(lockfile(base), lockfile(desktopDependency)), true);
        assert.equal(lockfileAffectsDesktop(lockfile(base), lockfile(scoped)), true);
        assert.equal(lockfileAffectsDesktop(null, lockfile(base)), true, 'an unreadable side is never ruled out');

        const decide = head => classifyChanges({
            files: changed(['package-lock.json']),
            manifests: { 'package-lock.json': { base: lockfile(base), head: lockfile(head) } },
        });
        const routine = decide(unrelated);
        assert.equal(routine.broad, true);
        assert.equal(routine.surfaces.desktop, false);
        assert.equal(routine.surfaces.api, true);
        assert.equal(decide(electron).surfaces.desktop, true);
    });

    test('a desktop-bundled package manifest still selects the desktop checks', () => {
        for (const path of ['apps/desktop/package.json', 'packages/cli/package.json', 'packages/client/package.json']) {
            const decision = classifyChanges({
                files: changed([path]),
                manifests: { [path]: { base: serialize({ name: 'x', version: '1.0.0' }), head: serialize({ name: 'x', version: '1.0.1' }) } },
            });
            assert.equal(decision.surfaces.desktop, true, path);
        }
        const shared = classifyChanges({
            files: changed(['packages/shared/package.json']),
            manifests: { 'packages/shared/package.json': { base: serialize({ name: 'x', version: '1.0.0' }), head: serialize({ name: 'x', version: '1.0.1' }) } },
        });
        assert.equal(shared.surfaces.desktop, false);
    });

    test('pull request labels are read from the triggering event', () => {
        const eventPath = join(freshDirectory('event'), 'event.json');
        writeFileSync(eventPath, JSON.stringify({ pull_request: { labels: [{ name: DESKTOP_CI_LABEL }, { name: 'bug' }] } }));
        assert.deepEqual(pullRequestLabels(eventPath), [DESKTOP_CI_LABEL, 'bug']);
        assert.deepEqual(pullRequestLabels(undefined), []);
        assert.deepEqual(pullRequestLabels(join(scratch, 'missing.json')), []);
    });
});

// --- diff resolution --------------------------------------------------------

describe('change resolution', () => {
    test('classifies the pull request contribution across multiple commits', () => {
        const { directory, base } = repositoryWithBranch('multi-commit');
        commit(directory, { 'packages/api/mcp/tools.ts': 'export const a = 1;\n' }, 'first');
        const head = commit(directory, { 'packages/api/mcp/server.ts': 'export const server = 2;\n' }, 'second');

        const decision = classifyRepository({
            repository: directory, baseSha: base, headSha: head,
            eventName: 'pull_request', allowFetch: false,
        });
        assert.equal(decision.status, 'ok');
        assert.deepEqual(selected(decision), ['api']);
        assert.deepEqual(decision.files.api.sort(),
            ['packages/api/mcp/server.ts', 'packages/api/mcp/tools.ts']);
    });

    test('ignores commits that only advanced the base branch', () => {
        const { directory, base } = repositoryWithBranch('base-advance');
        const head = commit(directory, { 'packages/api/mcp/tools.ts': 'export const a = 1;\n' }, 'feature');
        git(directory, ['checkout', '--quiet', 'main']);
        // The base branch advances with a desktop change that is not this
        // pull request's contribution.
        const advanced = commit(directory, { 'apps/desktop/src/main.ts': 'export const main = 1;\n' }, 'base advance');
        git(directory, ['checkout', '--quiet', 'feature']);

        const decision = classifyRepository({
            repository: directory, baseSha: advanced, headSha: head,
            eventName: 'pull_request', allowFetch: false,
        });
        assert.equal(decision.status, 'ok');
        assert.deepEqual(selected(decision), ['api']);
        assert.equal(decision.surfaces.desktop, false);
        assert.ok(decision.reasons.some(reason => reason.detail.includes(`merge base ${base}`)));
    });

    test('a rename across a surface boundary selects both the source and the destination', () => {
        const directory = newRepository('rename');
        const base = commit(directory, {
            'packages/api/src/moved.ts': 'export const moved = 1;\n',
            'README.md': 'readme\n',
        }, 'base');
        mkdirSync(join(directory, 'packages/cli/src'), { recursive: true });
        git(directory, ['mv', 'packages/api/src/moved.ts', 'packages/cli/src/moved.ts']);
        const head = commit(directory, {}, 'move into the CLI');

        const decision = classifyRepository({
            repository: directory, baseSha: base, headSha: head,
            eventName: 'pull_request', allowFetch: false,
        });
        assert.equal(decision.status, 'ok');
        assert.deepEqual(selected(decision).sort(), ['api', 'cli', 'connect', 'desktop']);
        const paths = decision.reasons.filter(reason => reason.path).map(reason => reason.path).sort();
        assert.deepEqual(paths, ['packages/api/src/moved.ts', 'packages/cli/src/moved.ts']);
    });

    test('a deletion is classified like any other change', () => {
        const directory = newRepository('deletion');
        const base = commit(directory, {
            'apps/desktop/src/main.ts': 'export const main = 1;\n',
            'packages/api/mcp/server.ts': 'export const server = 1;\n',
        }, 'base');
        const head = commit(directory, {}, 'remove the desktop entry point',
            { removed: ['apps/desktop/src/main.ts'] });

        const decision = classifyRepository({
            repository: directory, baseSha: base, headSha: head,
            eventName: 'pull_request', allowFetch: false,
        });
        assert.deepEqual(selected(decision), ['desktop']);
    });

    test('a shallow checkout is deepened before the merge base is trusted', () => {
        const origin = newRepository('shallow-origin');
        const base = commit(origin, { 'packages/api/mcp/server.ts': 'export const server = 1;\n' }, 'base');
        for (let index = 0; index < 5; index += 1) {
            commit(origin, { [`packages/api/mcp/step${index}.ts`]: `export const s = ${index};\n` }, `step ${index}`);
        }
        const head = git(origin, ['rev-parse', 'HEAD']);

        const shallow = freshDirectory('shallow-clone');
        execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${origin}`, shallow]);
        assert.equal(git(shallow, ['rev-parse', '--is-shallow-repository']), 'true');

        // Without a fetch the classifier cannot prove the merge base, so it
        // reports the conservative fallback rather than a narrow decision.
        const blocked = classifyRepository({
            repository: shallow, baseSha: base, headSha: head,
            eventName: 'pull_request', allowFetch: false,
        });
        assert.equal(blocked.status, 'fallback');
        assert.equal(blocked.broad, true);

        const deepened = classifyRepository({
            repository: shallow, baseSha: base, headSha: head,
            eventName: 'pull_request', allowFetch: true,
        });
        assert.equal(deepened.status, 'ok');
        assert.deepEqual(selected(deepened), ['api']);
        assert.equal(deepened.files.api.length, 5);
        assert.ok(deepened.reasons.some(reason => /deepened the shallow checkout/.test(reason.detail)));
    });

    for (const [name, mutate] of [
        ['a missing base', options => { options.baseSha = ''; }],
        ['a truncated base', options => { options.baseSha = 'abc1234'; }],
        ['a non-hex head', options => { options.headSha = 'z'.repeat(40); }],
        ['an unknown base', options => { options.baseSha = '0'.repeat(40); }],
        ['a path that is not a repository', options => { options.repository = freshDirectory('not-a-repo'); }],
    ]) {
        test(`${name} reports the conservative fallback`, () => {
            const { directory, base } = repositoryWithBranch(`invalid-${name.replace(/\W+/g, '-')}`);
            const head = commit(directory, { 'packages/api/mcp/tools.ts': 'export const a = 1;\n' }, 'feature');
            const options = {
                repository: directory, baseSha: base, headSha: head,
                eventName: 'pull_request', allowFetch: false,
            };
            mutate(options);
            const decision = classifyRepository(options);
            assert.equal(decision.status, 'fallback');
            assert.equal(decision.broad, true);
            assert.deepEqual(selected(decision), [...SURFACES]);
            assert.ok(decision.reasons[0].detail.length > 0);
        });
    }

    test('the #2501 change set classifies narrowly from a real diff', () => {
        // The exact path set and the exact semantic manifest delta of #2501,
        // resolved from a real two-commit branch rather than from a literal
        // file list.
        const directory = newRepository('issue-2501');
        const baseManifest = rootManifest();
        const headManifest = rootManifest();
        headManifest.scripts['test:mcp'] =
            `${headManifest.scripts['test:mcp']} packages/api/test/mcpActivity.test.ts`;
        const sources = [
            'packages/api/mcp/activityDigest.ts',
            'packages/api/mcp/presentation.ts',
            'packages/api/mcp/server.ts',
            'packages/api/mcp/tools.ts',
            'packages/api/mcp/toolsActivity.ts',
            'packages/api/test/fixtures/mcpActivity.ts',
            'packages/api/test/mcpConnectIntegration.test.ts',
            'packages/api/test/mcpIntegration.test.ts',
        ];
        const base = commit(directory, {
            // The manifest is written with a different indentation on the base
            // side, so the comparison has to be structural to see one change.
            'package.json': `${JSON.stringify(baseManifest, null, 4)}\n`,
            ...Object.fromEntries(sources.map(path => [path, 'export const before = 1;\n'])),
            'apps/desktop/src/main.ts': 'export const main = 1;\n',
            'propr-ui/src/App.tsx': 'export const App = 1;\n',
        }, 'base');
        commit(directory, {
            ...Object.fromEntries(sources.map(path => [path, 'export const after = 2;\n'])),
        }, 'MCP activity digest');
        const head = commit(directory, {
            'packages/api/test/mcpActivity.test.ts': 'export const added = 1;\n',
            'package.json': `${JSON.stringify(headManifest, null, 2)}\n`,
        }, 'cover the new suite');

        const decision = classifyRepository({
            repository: directory, baseSha: base, headSha: head,
            eventName: 'pull_request', allowFetch: false,
        });
        assert.equal(decision.status, 'ok');
        assert.equal(decision.broad, false);
        assert.deepEqual(selected(decision), ['api']);
        assert.deepEqual(decision.files.api.sort(),
            [...sources, 'package.json', 'packages/api/test/mcpActivity.test.ts'].sort());
        assert.ok(decision.reasons.some(reason =>
            reason.path === 'package.json' && /test:mcp/.test(reason.detail)));
    });

    test('an unchanged head still selects every surface', () => {
        const { directory, base } = repositoryWithBranch('no-change');
        const decision = classifyRepository({
            repository: directory, baseSha: base, headSha: base,
            eventName: 'pull_request', allowFetch: false,
        });
        assert.equal(decision.broad, true);
    });
});

// --- command line -----------------------------------------------------------

describe('classifier command line', () => {
    // The runner's own event (a nightly run is `schedule`) and any classifier
    // inputs must not leak into the child, or it validates every surface.
    const AMBIENT = /^(GITHUB_EVENT_NAME|PROPR_CLASSIFY_.*)$/;
    const hermeticEnvironment = () => Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !AMBIENT.test(name)));

    const runClassifier = (args, { cwd = REPOSITORY, environment = {} } = {}) => {
        const directory = freshDirectory('cli-run');
        const outputFile = join(directory, 'output.txt');
        const summaryFile = join(directory, 'summary.md');
        writeFileSync(outputFile, '');
        writeFileSync(summaryFile, '');
        const result = spawnSync(process.execPath, [CLASSIFIER, ...args], {
            cwd,
            encoding: 'utf8',
            env: {
                ...hermeticEnvironment(),
                GITHUB_OUTPUT: outputFile,
                GITHUB_STEP_SUMMARY: summaryFile,
                ...environment,
            },
        });
        const outputs = Object.fromEntries(readFileSync(outputFile, 'utf8')
            .split('\n').filter(Boolean)
            .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
        return { ...result, outputs, summary: readFileSync(summaryFile, 'utf8') };
    };

    test('writes one output per surface, the file lists and a readable summary', () => {
        const { directory, base } = repositoryWithBranch('cli-outputs');
        const head = commit(directory, { 'packages/api/mcp/tools.ts': 'export const a = 1;\n' }, 'feature');
        const result = runClassifier(
            ['--base', base, '--head', head, '--repo', directory, '--github-output', '--summary', '--no-fetch'],
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.outputs.status, 'ok');
        assert.equal(result.outputs.broad, 'false');
        assert.equal(result.outputs.api, 'true');
        assert.equal(result.outputs.desktop, 'false');
        assert.equal(result.outputs.cli, 'false');
        assert.equal(result.outputs.connect, 'false');
        for (const surface of SURFACES) {
            assert.ok(Object.hasOwn(result.outputs, surface), `${surface} output is missing`);
            assert.ok(Object.hasOwn(result.outputs, `${surface}_files`), `${surface}_files output is missing`);
        }
        assert.deepEqual(JSON.parse(result.outputs.api_files), ['packages/api/mcp/tools.ts']);
        assert.equal(result.outputs.core_package_source, 'false');
        assert.deepEqual(JSON.parse(result.outputs.core_package_source_files), []);
        assert.match(result.summary, /## CI change classification/);
        assert.match(result.summary, /packages\/api\/mcp\/tools\.ts/);
        assert.match(result.stdout, /decision: status=ok broad=false/);
    });

    test('an unresolvable change set still writes broad outputs and exits zero by default', () => {
        const { directory } = repositoryWithBranch('cli-fallback');
        const result = runClassifier(
            ['--base', '0'.repeat(40), '--head', '1'.repeat(40), '--repo', directory, '--github-output', '--no-fetch'],
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.outputs.status, 'fallback');
        assert.equal(result.outputs.broad, 'true');
        for (const surface of SURFACES) assert.equal(result.outputs[surface], 'true', surface);
    });

    test('--require-resolution fails the step instead of reporting the fallback silently', () => {
        const { directory } = repositoryWithBranch('cli-require');
        const result = runClassifier([
            '--base', '0'.repeat(40), '--head', '1'.repeat(40), '--repo', directory,
            '--github-output', '--require-resolution', '--no-fetch',
        ]);
        assert.equal(result.status, 1);
        assert.equal(result.outputs.broad, 'true');
        assert.match(result.stderr, /Change resolution failed/);
    });

    test('a malformed invocation reports the fallback rather than nothing', () => {
        const result = runClassifier(['--not-a-flag', '--github-output']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.outputs.status, 'fallback');
        for (const surface of SURFACES) assert.equal(result.outputs[surface], 'true', surface);
    });

    test('reads the base and head from the environment when no flags are given', () => {
        const { directory, base } = repositoryWithBranch('cli-env');
        const head = commit(directory, { 'apps/desktop/src/main.ts': 'export const main = 1;\n' }, 'feature');
        const result = runClassifier(['--github-output', '--no-fetch'], {
            cwd: directory,
            environment: {
                PROPR_CLASSIFY_BASE_SHA: base,
                PROPR_CLASSIFY_HEAD_SHA: head,
                PROPR_CLASSIFY_EVENT: 'pull_request',
            },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.outputs.desktop, 'true');
        assert.equal(result.outputs.api, 'false');
    });

    test('falls back to the GitHub event name and validates every surface for a schedule', () => {
        const { directory, base } = repositoryWithBranch('cli-schedule');
        const head = commit(directory, { 'packages/api/mcp/tools.ts': 'export const a = 1;\n' }, 'feature');
        const result = runClassifier(
            ['--base', base, '--head', head, '--repo', directory, '--github-output', '--no-fetch'],
            { environment: { GITHUB_EVENT_NAME: 'schedule' } },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.outputs.broad, 'true');
        for (const surface of SURFACES) assert.equal(result.outputs[surface], 'true', surface);
    });

    test('the summary names every surface and the reason for each path', () => {
        const decision = classifyPaths(['apps/desktop/src/main.ts']);
        const summary = renderSummary(decision);
        for (const surface of SURFACES) assert.ok(summary.includes(`\`${surface}\``), surface);
        assert.match(summary, /apps\/desktop\/src\/main\.ts/);
        assert.match(summary, /not applicable/);
    });
});

// --- workflow wiring --------------------------------------------------------

const WORKFLOWS = {
    buildCheck: 'pr-build-check.yml',
    fullSuite: 'pr-test-on-label.yml',
    cliCompatibility: 'cli-node-compatibility.yml',
    desktopRelease: 'desktop-release-guard.yml',
    desktopConnect: 'desktop-connect-discovery-guard.yml',
};

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

/** Run a workflow gate script with GitHub's step files provided. */
function runGate(script, environment) {
    const directory = freshDirectory('gate');
    const outputFile = join(directory, 'output.txt');
    const summaryFile = join(directory, 'summary.md');
    writeFileSync(outputFile, '');
    writeFileSync(summaryFile, '');
    const result = spawnSync('bash', ['-c', script], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile, ...environment },
    });
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        outputs: readFileSync(outputFile, 'utf8'),
    };
}

describe('workflow wiring', () => {
    const buildCheck = readWorkflow(WORKFLOWS.buildCheck);
    const fullSuite = readWorkflow(WORKFLOWS.fullSuite);
    const cliCompatibility = readWorkflow(WORKFLOWS.cliCompatibility);
    const desktopRelease = readWorkflow(WORKFLOWS.desktopRelease);
    const desktopConnect = readWorkflow(WORKFLOWS.desktopConnect);

    test('every classifying workflow uses the one shared action', () => {
        for (const [name, workflow] of Object.entries({
            buildCheck, fullSuite, cliCompatibility, desktopRelease, desktopConnect,
        })) {
            assert.ok(workflow.includes('uses: ./.github/actions/classify-changes'),
                `${name} must classify through the shared action`);
            assert.ok(!/git diff --name-status/.test(workflow),
                `${name} must not restate the classification rules inline`);
        }
        // The action is the only place the script is wired into CI.
        const action = readFileSync(
            join(REPOSITORY, '.github', 'actions', 'classify-changes', 'action.yml'), 'utf8');
        assert.ok(action.includes('scripts/ci-change-classification.mjs'));
    });

    test('desktop checks run on demand: the label request and the nightly run call them', () => {
        // The unsigned validation includes scheduled and manually dispatched nightly runs.
        for (const job of ['validation-version', 'renderer-axe-boundary', 'package', 'finalize']) {
            const block = jobBlock(desktopRelease, job);
            assert.ok(block.includes("github.event_name != 'push'"), `${job} runs for every event except a push`);
        }
        const releaseTrigger = desktopRelease.slice(desktopRelease.indexOf('on:'), desktopRelease.indexOf('permissions:'));
        assert.match(releaseTrigger, /workflow_call:/);
        assert.doesNotMatch(desktopRelease, /workflow_dispatch:/, 'a production release must never be dispatchable');
        for (const workflow of [desktopRelease, desktopConnect]) {
            const trigger = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'));
            assert.match(trigger, /workflow_call:/);
            // A per-PR concurrency group would let any label change cancel a real run.
            assert.doesNotMatch(trigger, /labeled/);
        }

        const request = readWorkflow('desktop-ci-request.yml');
        assert.match(request, /types: \[labeled\]/);
        for (const [job, workflow] of [['desktop-package', 'desktop-release-guard.yml'], ['desktop-connect', 'desktop-connect-discovery-guard.yml']]) {
            const block = jobBlock(request, job);
            assert.ok(block.includes(`uses: ./.github/workflows/${workflow}`));
            assert.ok(block.includes(`github.event.label.name == '${DESKTOP_CI_LABEL}'`));
            assert.ok(block.includes('github.event.pull_request.head.repo.full_name == github.repository'));
            assert.doesNotMatch(block, /secrets:/, 'no secrets reach a pull request call');
        }

        const nightly = readWorkflow('test-nightly.yml');
        assert.match(nightly, /schedule:/);
        assert.match(nightly, /workflow_dispatch:/);
        assert.ok(jobBlock(nightly, 'desktop-package').includes('uses: ./.github/workflows/desktop-release-guard.yml'));
        assert.ok(jobBlock(nightly, 'desktop-connect').includes('uses: ./.github/workflows/desktop-connect-discovery-guard.yml'));
        assert.ok(jobBlock(nightly, 'native-electron').includes("PROPR_REQUIRE_NATIVE_ELECTRON: '1'"));
    });

    for (const eventName of ['pull_request', 'schedule', 'workflow_dispatch', 'push']) {
        test(`unsigned desktop job conditions handle ${eventName}`, () => {
            for (const job of ['validation-version', 'renderer-axe-boundary', 'package', 'finalize']) {
                const condition = jobBlock(desktopRelease, job).match(/\n    if: (?:>-\n\s*)?\$\{\{([\s\S]*?)\}\}/)?.[1];
                assert.ok(condition, `${job} has a job-level condition`);
                // These conditions use the JS-compatible boolean subset of Actions expressions.
                const expression = condition.replace(/needs\.([\w-]+)/g, 'needs["$1"]');
                for (const desktop of ['true', 'false', '']) {
                    for (const cancelled of [false, true]) {
                        const actual = runInNewContext(expression, {
                            github: { event_name: eventName, ref_type: eventName === 'push' ? 'tag' : 'branch' },
                            cancelled: () => cancelled,
                            needs: {
                                // Non-PR calls skip classification and expose an empty output.
                                classify: { outputs: { desktop } },
                                'validation-version': { result: 'success' },
                                'renderer-axe-boundary': { result: 'success' },
                            },
                        });
                        assert.equal(actual,
                            !cancelled && eventName !== 'push' && (job === 'finalize' || desktop !== 'false'),
                            `${job}: event=${eventName}, desktop=${JSON.stringify(desktop)}, cancelled=${cancelled}`);
                    }
                }
            }
        });
    }

    test('the full suite gate accepts the on-demand desktop skip even for a broad change', () => {
        const gate = jobBlock(fullSuite, 'test');
        assert.match(gate, /on_demand_gated "Hosted native Electron units"/);
        const onDemand = gate.slice(gate.indexOf('on_demand_gated() {'), gate.indexOf('# A matrix result'));
        assert.ok(!onDemand.includes('CLASSIFY_BROAD'), 'a broad change may still leave the desktop checks to the nightly run');
        assert.ok(onDemand.includes('"${EVENT_NAME:-}" = pull_request'), 'only a pull request may skip them');
        assert.ok(onDemand.includes('"${CLASSIFY_STATUS:-}" = ok'), 'a fallback classification still requires them');
    });

    test('gated jobs skip only on an explicit false and keep run cancellation', () => {
        const gated = [
            [buildCheck, 'cli-node-matrix', 'cli'],
            [buildCheck, 'cli-agent-skill-glibc-231', 'cli'],
            [buildCheck, 'cli-agent-skill-darwin', 'cli'],
            [buildCheck, 'windows-connect-discovery', 'connect'],
            [buildCheck, 'connect-authority-darwin', 'connect'],
            [cliCompatibility, 'project-options', 'cli'],
            [desktopRelease, 'native-windows-durability', 'desktop'],
            [desktopRelease, 'validation-version', 'desktop'],
            [desktopRelease, 'renderer-axe-boundary', 'desktop'],
            [desktopRelease, 'package', 'desktop'],
            [desktopConnect, 'packaged-connect-discovery', 'desktop'],
            [fullSuite, 'docs', 'docs'],
            [fullSuite, 'native-electron', 'desktop'],
        ];
        for (const [workflow, job, surface] of gated) {
            const block = jobBlock(workflow, job);
            assert.ok(block.includes(`needs.classify.outputs.${surface} != 'false'`),
                `${job} must skip only on an explicit false decision`);
            assert.ok(!new RegExp(`needs\\.classify\\.outputs\\.${surface} == 'true'`).test(block),
                `${job} must not require an explicit true decision`);
            assert.ok(block.includes('!cancelled()'),
                `${job} must keep superseded-run cancellation`);
        }
    });

    test('the build check detects changes with the shared action and fails closed', () => {
        const validate = jobBlock(buildCheck, 'validate');
        assert.match(validate, /- name: Detect Changes\n\s+id: filter\n\s+uses: \.\/\.github\/actions\/classify-changes\n\s+with:\n\s+require-resolution: 'true'/);
        assert.ok(validate.includes('fetch-depth: 0'),
            'the validate checkout must contain the merge base');
        // No decision is ever read as `== true`, so an empty output runs the work.
        assert.ok(!/steps\.filter\.outputs\.\w+ == 'true'/.test(validate));
        for (const surface of ['CORE', 'UI', 'DOCS', 'CORE_PACKAGE', 'CLI', 'API']) {
            assert.ok(validate.includes(`FILTER_${surface}:`), `${surface} decision must reach the script as data`);
            assert.ok(validate.includes(`[ "\${FILTER_${surface}:-}" != 'false' ]`), surface);
        }
    });

    test('the full suite narrows only docs and native Electron, never the backend shards', () => {
        // Selection and gate semantics are evaluated in
        // test/ciFullSuiteSelection.test.mjs; this pins the wiring.
        const shard = jobBlock(fullSuite, 'shard');
        assert.ok(!shard.includes('classify'), 'backend shards must stay unconditional');
        assert.ok(/\n {4}needs: route\n/.test(shard), 'backend shards wait only for runner selection, never for the classifier');
        assert.ok(jobBlock(fullSuite, 'classify').includes("if: ${{ github.event_name == 'pull_request' && !github.event.pull_request.draft }}"),
            'manual dispatch never consults the classifier');
        assert.ok(fullSuite.includes('--verify-shard-summaries'),
            'exact shard coverage verification must be preserved');
        assert.ok(fullSuite.includes('shard: [1, 2, 3, 4]'), 'the shard matrix must be preserved');
    });

    test('desktop workflows no longer hide a shared or classifier change behind a path filter', () => {
        for (const [name, workflow] of Object.entries({ desktopRelease, desktopConnect, cliCompatibility })) {
            const header = workflow.slice(0, workflow.indexOf('\njobs:'));
            assert.ok(!/^\s+paths:/m.test(header),
                `${name} must not carry a workflow-level path filter the classifier cannot see past`);
        }
    });

    test('the release and manual routes are untouched by the classifier', () => {
        for (const job of ['preflight', 'runtime-preflight', 'release-package', 'release-finalize', 'sign', 'publish']) {
            const block = jobBlock(desktopRelease, job);
            assert.ok(!block.includes('classify'), `${job} must not depend on the classifier`);
        }
        assert.ok(jobBlock(desktopRelease, 'preflight')
            .includes("github.event_name == 'push' && github.ref_type == 'tag'"));
        assert.ok(jobBlock(desktopRelease, 'classify').includes("if: github.event_name == 'pull_request'"),
            'the classifier runs for pull requests only in the release guard');
        // Manual dispatch never reaches a narrow decision.
        const dispatched = classifyChanges({
            files: changed(['packages/api/mcp/server.ts']),
            eventName: 'workflow_dispatch',
        });
        assert.equal(dispatched.broad, true);
    });
});

describe('gate semantics', () => {
    const buildCheck = readWorkflow(WORKFLOWS.buildCheck);
    const desktopRelease = readWorkflow(WORKFLOWS.desktopRelease);
    const desktopConnect = readWorkflow(WORKFLOWS.desktopConnect);
    const cliCompatibility = readWorkflow(WORKFLOWS.cliCompatibility);

    const compatibilityGate = extractRunBlock(
        jobBlock(buildCheck, 'compatibility-guard'), 'Enforce compatibility results');
    const successfulCompatibility = {
        CLASSIFY_RESULT: 'success',
        CLASSIFY_STATUS: 'ok',
        CLI_DECISION: 'true',
        CONNECT_DECISION: 'true',
        CLI_MATRIX_RESULT: 'success',
        CLI_GLIBC_RESULT: 'success',
        CLI_DARWIN_RESULT: 'success',
        CONNECT_WINDOWS_RESULT: 'success',
        CONNECT_DARWIN_RESULT: 'success',
    };

    test('the compatibility guard passes when every constituent succeeded', () => {
        assert.equal(runGate(compatibilityGate, successfulCompatibility).status, 0);
    });

    test('the compatibility guard accepts a skip only for a proved inapplicable surface', () => {
        const inapplicable = {
            ...successfulCompatibility,
            CLI_DECISION: 'false',
            CONNECT_DECISION: 'false',
            CLI_MATRIX_RESULT: 'skipped',
            CLI_GLIBC_RESULT: 'skipped',
            CLI_DARWIN_RESULT: 'skipped',
            CONNECT_WINDOWS_RESULT: 'skipped',
            CONNECT_DARWIN_RESULT: 'skipped',
        };
        const passed = runGate(compatibilityGate, inapplicable);
        assert.equal(passed.status, 0, passed.stdout);
        assert.match(passed.stdout, /proved its surface inapplicable/);

        // A skip without a decision that justifies it fails.
        assert.equal(runGate(compatibilityGate, { ...inapplicable, CLI_DECISION: 'true' }).status, 1);
        // A classifier that fell back is not trusted to justify a skip.
        assert.equal(runGate(compatibilityGate, { ...inapplicable, CLASSIFY_STATUS: 'fallback' }).status, 1);
        // Nor is a classifier job that failed outright.
        assert.equal(runGate(compatibilityGate, { ...inapplicable, CLASSIFY_RESULT: 'failure' }).status, 1);
    });

    for (const [label, result] of [
        ['failure', 'failure'],
        ['cancellation', 'cancelled'],
        ['a job that never ran', ''],
    ]) {
        test(`the compatibility guard fails on ${label}`, () => {
            const failed = runGate(compatibilityGate, {
                ...successfulCompatibility, CLI_MATRIX_RESULT: result,
            });
            assert.equal(failed.status, 1);
        });
    }

    const finalizeGate = extractRunBlock(
        jobBlock(desktopRelease, 'finalize'), 'Resolve desktop packaging applicability');

    test('nightly desktop finalization requires validation when classification was skipped', () => {
        const nightly = {
            CLASSIFY_RESULT: 'skipped',
            CLASSIFY_STATUS: '',
            DESKTOP_DECISION: '',
            VERSION_RESULT: 'success',
            PACKAGE_RESULT: 'success',
        };
        const passed = runGate(finalizeGate, nightly);
        assert.equal(passed.status, 0, passed.stdout);
        assert.match(passed.outputs, /applicable=true/);
        for (const key of ['VERSION_RESULT', 'PACKAGE_RESULT']) {
            for (const result of ['failure', 'cancelled', 'skipped', '']) {
                assert.equal(runGate(finalizeGate, { ...nightly, [key]: result }).status, 1,
                    `${key}=${JSON.stringify(result)} must fail nightly validation`);
            }
        }
    });

    test('the desktop finalize gate distinguishes inapplicable from failed or missing', () => {
        const inapplicable = runGate(finalizeGate, {
            CLASSIFY_RESULT: 'success',
            CLASSIFY_STATUS: 'ok',
            DESKTOP_DECISION: 'false',
            VERSION_RESULT: 'skipped',
            PACKAGE_RESULT: 'skipped',
        });
        assert.equal(inapplicable.status, 0, inapplicable.stdout);
        assert.match(inapplicable.outputs, /applicable=false/);

        const applicable = runGate(finalizeGate, {
            CLASSIFY_RESULT: 'success',
            CLASSIFY_STATUS: 'ok',
            DESKTOP_DECISION: 'true',
            VERSION_RESULT: 'success',
            PACKAGE_RESULT: 'success',
        });
        assert.equal(applicable.status, 0, applicable.stdout);
        assert.match(applicable.outputs, /applicable=true/);

        for (const broken of [
            { PACKAGE_RESULT: 'failure' },
            { PACKAGE_RESULT: 'cancelled' },
            { PACKAGE_RESULT: '' },
            { PACKAGE_RESULT: 'skipped' },
            { DESKTOP_DECISION: 'false', VERSION_RESULT: 'skipped', PACKAGE_RESULT: 'skipped', CLASSIFY_STATUS: 'fallback' },
        ]) {
            const failed = runGate(finalizeGate, {
                CLASSIFY_RESULT: 'success',
                CLASSIFY_STATUS: 'ok',
                DESKTOP_DECISION: 'true',
                VERSION_RESULT: 'success',
                ...broken,
            });
            assert.equal(failed.status, 1, `${JSON.stringify(broken)} must fail the gate`);
        }
    });

    for (const [name, workflow, job, step, decisionKey, resultKey] of [
        ['packaged Connect', desktopConnect, 'packaged-connect-guard',
            'Enforce packaged Connect discovery results', 'DESKTOP_DECISION', 'MATRIX_RESULT'],
        ['CLI Node compatibility', cliCompatibility, 'cli-node-compatibility-guard',
            'Enforce CLI Node compatibility results', 'CLI_DECISION', 'MATRIX_RESULT'],
    ]) {
        test(`the ${name} guard fails closed`, () => {
            const gate = extractRunBlock(jobBlock(workflow, job), step);
            const base = {
                CLASSIFY_RESULT: 'success',
                CLASSIFY_STATUS: 'ok',
                [decisionKey]: 'true',
                [resultKey]: 'success',
            };
            assert.equal(runGate(gate, base).status, 0);
            assert.equal(runGate(gate, {
                ...base, [decisionKey]: 'false', [resultKey]: 'skipped',
            }).status, 0);
            for (const broken of ['failure', 'cancelled', 'skipped', '']) {
                assert.equal(runGate(gate, { ...base, [resultKey]: broken }).status, 1, broken);
            }
            assert.equal(runGate(gate, {
                ...base, CLASSIFY_STATUS: 'fallback', [decisionKey]: 'false', [resultKey]: 'skipped',
            }).status, 1);
        });
    }

    test('every aggregate keeps a stable meaningful name', () => {
        assert.ok(buildCheck.includes('name: CLI and Connect Compatibility Guard'));
        assert.ok(desktopRelease.includes('name: Finalize unsigned validation checksums'));
        assert.ok(desktopConnect.includes('name: Packaged Connect Discovery Guard'));
        assert.ok(cliCompatibility.includes('name: CLI Node Compatibility Guard'));
        assert.ok(readWorkflow(WORKFLOWS.fullSuite).includes('name: Run Full Test Suite'));
    });
});
