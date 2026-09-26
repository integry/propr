import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

import {
    RENDERER_INPUT_PATHS,
    RENDERER_WORKSPACES,
    STAMP_PATH,
    STAMP_SCHEMA_VERSION,
    buildCommand,
    computeInputKey,
    listOutputFiles,
    listSourceFiles,
    missingOutputs,
    outputDifferences,
    prepareRenderer,
    readStamp,
    toolchainKey,
} from './prepare-renderer.mjs';

const scratch = [];
after(() => { for (const directory of scratch) rmSync(directory, { recursive: true, force: true }); });

function write(root, relative, contents) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
}

// Files a real build emits that the declared `outputs` never name: the sibling
// modules an entry point imports, their declarations, and members of a copied
// asset tree. A hand-picked output list is blind to all of them.
function generatedSiblings(workspace) {
    const nested = [
        `${workspace.outputDirectory}/internal/helper.js`,
        `${workspace.outputDirectory}/internal/helper.d.ts`,
        `${workspace.outputDirectory}/internal/deep/util.js`,
    ];
    if (workspace.name === '@propr/cli') nested.push(`${workspace.outputDirectory}/skill/propr/reference/notes.md`);
    return nested;
}

// A repository double: one source file per built workspace, and the outputs
// produced by the fake builds rather than by tsc.
function createFixture() {
    const root = mkdtempSync(join(tmpdir(), 'propr-prepare-renderer-'));
    scratch.push(root);
    for (const workspace of RENDERER_WORKSPACES) write(root, `${workspace.directory}/src/index.ts`, `// ${workspace.name}\n`);
    write(root, 'package.json', '{"name":"fixture"}\n');
    write(root, 'package-lock.json', '{"lockfileVersion":3}\n');
    const sources = () => [
        ...RENDERER_WORKSPACES.map(workspace => `${workspace.directory}/src/index.ts`),
        'package-lock.json',
        'package.json',
    ].sort((a, b) => a.localeCompare(b));
    const calls = [];
    const run = (buildRoot, name) => {
        calls.push(name);
        const workspace = RENDERER_WORKSPACES.find(candidate => candidate.name === name);
        for (const output of workspace.outputs) write(buildRoot, output, `built ${name}\n`);
        for (const output of generatedSiblings(workspace)) write(buildRoot, output, `built ${name}\n`);
        return 0;
    };
    return {
        root,
        calls,
        prepare: (overrides = {}) => prepareRenderer({
            root,
            run,
            log: () => {},
            listFiles: sources,
            ...overrides,
        }),
        sources,
    };
}

describe('desktop renderer preparation reuse', () => {
    test('builds every workspace in dependency order and records a stamp', () => {
        const fixture = createFixture();
        const result = fixture.prepare();

        assert.equal(result.reused, false);
        assert.deepEqual(fixture.calls, ['@propr/shared', '@propr/local-setup', '@propr/cli', '@propr/client']);
        assert.deepEqual(missingOutputs(fixture.root), []);
        assert.equal(readStamp(fixture.root).key, result.key);
        assert.deepEqual(readStamp(fixture.root).toolchain, toolchainKey());
    });

    test('reuses a build whose inputs and outputs are all unchanged', () => {
        const fixture = createFixture();
        const first = fixture.prepare();
        fixture.calls.length = 0;

        const second = fixture.prepare();
        assert.equal(second.reused, true);
        assert.equal(second.key, first.key);
        assert.deepEqual(fixture.calls, [], 'no workspace is rebuilt');
    });

    test('rebuilds when any source byte changes', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        write(fixture.root, 'packages/shared/src/index.ts', '// changed\n');
        const result = fixture.prepare();
        assert.equal(result.reused, false);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
    });

    test('rebuilds when the lockfile changes even though no workspace source did', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        write(fixture.root, 'package-lock.json', '{"lockfileVersion":3,"changed":true}\n');
        assert.equal(fixture.prepare().reused, false);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
    });

    test('rebuilds for a different toolchain', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        const result = fixture.prepare({ runtime: { version: 'v24.0.0', platform: process.platform, arch: process.arch } });
        assert.equal(result.reused, false);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
    });

    test('rebuilds when a declared output is missing despite a matching stamp', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        rmSync(join(fixture.root, 'packages/cli/dist/skill/propr/SKILL.md'));
        assert.equal(fixture.prepare().reused, false);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
        assert.deepEqual(missingOutputs(fixture.root), []);
    });

    test('rebuilds when a generated file the outputs list does not name disappears', () => {
        // The reported hole: `dist/index.js` and `dist/index.d.ts` are still
        // there, so the declared outputs all pass, but the tree is incomplete.
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        const orphan = 'packages/shared/dist/internal/helper.js';
        rmSync(join(fixture.root, orphan));
        assert.ok(existsSync(join(fixture.root, 'packages/shared/dist/index.js')));
        assert.ok(existsSync(join(fixture.root, 'packages/shared/dist/index.d.ts')));
        assert.deepEqual(missingOutputs(fixture.root), [], 'every declared output is still present');

        const result = fixture.prepare();
        assert.equal(result.reused, false, 'an incomplete dist tree is never reused');
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
        assert.ok(existsSync(join(fixture.root, orphan)), 'the rebuild restores it');
        assert.deepEqual(fixture.prepare().reused, true, 'and the restored tree is reusable again');
    });

    test('rebuilds when a nested declaration or a copied asset disappears', () => {
        for (const generated of [
            'packages/client/dist/internal/deep/util.js',
            'packages/local-setup/dist/internal/helper.d.ts',
            'packages/cli/dist/skill/propr/reference/notes.md',
        ]) {
            const fixture = createFixture();
            fixture.prepare();
            fixture.calls.length = 0;

            rmSync(join(fixture.root, generated));
            assert.equal(fixture.prepare().reused, false, generated);
            assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length, generated);
        }
    });

    test('rebuilds when a generated file is truncated or overwritten', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        write(fixture.root, 'packages/cli/dist/internal/helper.js', '');
        assert.equal(fixture.prepare().reused, false);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
    });

    test('rebuilds when an unrecorded file appears in an output directory', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        write(fixture.root, 'packages/shared/dist/internal/stale.js', '// not from this build\n');
        assert.equal(fixture.prepare().reused, false, 'the tree is not the one that was built');
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
    });

    test('keeps reusing when only incremental build state changes in an output directory', () => {
        // `tsc --noEmit` rewrites .tsbuildinfo without producing any output, so
        // it is bookkeeping rather than part of the generated tree.
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        write(fixture.root, 'packages/shared/dist/tsconfig.tsbuildinfo', '{"version":"5"}\n');
        assert.equal(fixture.prepare().reused, true);
        assert.deepEqual(fixture.calls, []);
    });

    test('records the whole generated tree, not just the declared outputs', () => {
        const fixture = createFixture();
        fixture.prepare();

        const recorded = readStamp(fixture.root).outputs;
        const paths = recorded.map(entry => entry.path);
        for (const workspace of RENDERER_WORKSPACES) {
            for (const output of [...workspace.outputs, ...generatedSiblings(workspace)]) {
                assert.ok(paths.includes(output), output);
            }
        }
        assert.ok(recorded.every(entry => Number.isInteger(entry.size)));
        assert.deepEqual(outputDifferences(fixture.root, recorded), []);
        assert.deepEqual(listOutputFiles(fixture.root).map(entry => entry.path), paths);
    });

    test('refuses a stamp that carries no usable output inventory', () => {
        const fixture = createFixture();
        const first = fixture.prepare();
        fixture.calls.length = 0;

        for (const outputs of [undefined, 'all of them', [{ path: 'packages/shared/dist/index.js' }]]) {
            write(fixture.root, STAMP_PATH, `${JSON.stringify({
                schemaVersion: STAMP_SCHEMA_VERSION,
                key: first.key,
                toolchain: toolchainKey(),
                outputs,
            })}\n`);
            assert.equal(readStamp(fixture.root), null, JSON.stringify(outputs ?? null));
            assert.equal(fixture.prepare().reused, false, JSON.stringify(outputs ?? null));
        }
    });

    test('rebuilds, rather than failing to hash, when a listed source has been deleted', () => {
        // `git ls-files --cached` keeps listing a tracked file whose deletion
        // has not been staged. Deleting or renaming a source is a changed
        // input: invalidate and let the compiler judge the new tree.
        const fixture = createFixture();
        const first = fixture.prepare();
        fixture.calls.length = 0;

        rmSync(join(fixture.root, 'packages/client/src/index.ts'));
        const second = fixture.prepare();
        assert.equal(second.reused, false);
        assert.notEqual(second.key, first.key, 'the absent source changes the key');
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
        assert.equal(readStamp(fixture.root).key, second.key);

        fixture.calls.length = 0;
        const third = fixture.prepare();
        assert.equal(third.reused, true, 'the tree without that source is itself reusable');
        assert.deepEqual(fixture.calls, []);

        write(fixture.root, 'packages/client/src/index.ts', '// @propr/client\n');
        const restored = fixture.prepare();
        assert.equal(restored.reused, false, 'restoring the source invalidates again');
        assert.equal(restored.key, first.key, 'and returns the original key');
    });

    test('hashes a deleted input as absent instead of throwing', () => {
        const fixture = createFixture();
        const files = fixture.sources();
        const toolchain = toolchainKey();
        const before = computeInputKey(fixture.root, files, toolchain);

        rmSync(join(fixture.root, 'packages/shared/src/index.ts'));
        const vanished = [];
        const after = computeInputKey(fixture.root, files, toolchain, vanished);
        assert.deepEqual(vanished, ['packages/shared/src/index.ts']);
        assert.notEqual(after, before);
        assert.equal(computeInputKey(fixture.root, files, toolchain), after, 'and stays stable while it is gone');
    });

    test('fails closed when a listed source cannot be read for a reason other than absence', () => {
        // A directory where a file is expected is a read error, not a deletion:
        // the key cannot be computed honestly, so nothing may be reused.
        const fixture = createFixture();
        fixture.prepare();

        mkdirSync(join(fixture.root, 'packages/shared/src/unreadable'), { recursive: true });
        const listFiles = () => [...fixture.sources(), 'packages/shared/src/unreadable'];
        assert.throws(() => computeInputKey(fixture.root, listFiles(), toolchainKey()), error => error?.code === 'EISDIR');
        assert.throws(() => fixture.prepare({ listFiles }), error => error?.code === 'EISDIR');
    });

    test('never reuses when the source list cannot be determined', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        const result = fixture.prepare({ listFiles: () => null });
        assert.equal(result.reused, false);
        assert.equal(result.key, null);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
        assert.equal(readStamp(fixture.root), null, 'an unkeyed build writes no stamp');
    });

    test('fails closed and leaves no stamp when a build fails', () => {
        const fixture = createFixture();
        fixture.prepare();
        assert.ok(existsSync(join(fixture.root, STAMP_PATH)));
        fixture.calls.length = 0;

        write(fixture.root, 'packages/shared/src/index.ts', '// changed\n');
        assert.throws(() => fixture.prepare({
            run: (_root, name) => {
                fixture.calls.push(name);
                return name === '@propr/cli' ? 2 : 0;
            },
        }), /building @propr\/cli failed with exit code 2/);
        assert.deepEqual(fixture.calls, ['@propr/shared', '@propr/local-setup', '@propr/cli'], 'stops at the failure');
        assert.equal(readStamp(fixture.root), null);
        assert.ok(!existsSync(join(fixture.root, STAMP_PATH)));
    });

    test('fails closed when a build reports success without producing its outputs', () => {
        const fixture = createFixture();
        assert.throws(() => fixture.prepare({ run: () => 0 }), /expected build output is missing/);
        assert.equal(readStamp(fixture.root), null);
    });

    test('--force rebuilds an otherwise reusable tree', () => {
        const fixture = createFixture();
        fixture.prepare();
        fixture.calls.length = 0;

        assert.equal(fixture.prepare({ force: true }).reused, false);
        assert.equal(fixture.calls.length, RENDERER_WORKSPACES.length);
    });

    test('keys the same inputs identically and different inputs differently', () => {
        const fixture = createFixture();
        const files = fixture.sources();
        const toolchain = toolchainKey();
        const key = computeInputKey(fixture.root, files, toolchain);

        assert.equal(computeInputKey(fixture.root, files, toolchain), key);
        assert.notEqual(computeInputKey(fixture.root, files, { ...toolchain, arch: 'other' }), key);
        write(fixture.root, 'packages/client/src/index.ts', '// different\n');
        assert.notEqual(computeInputKey(fixture.root, files, toolchain), key);
    });

    test('keeps the stamp inside node_modules so installs and clean checkouts discard it', () => {
        assert.match(STAMP_PATH.replaceAll('\\', '/'), /^node_modules\//);
    });

    test('runs the workspace build through npm on every platform', () => {
        assert.deepEqual(buildCommand('@propr/shared', 'linux'), ['npm', ['run', 'build', '-w', '@propr/shared']]);
        assert.deepEqual(buildCommand('@propr/shared', 'win32'), ['npm.cmd', ['run', 'build', '-w', '@propr/shared']]);
    });
});

describe('desktop renderer preparation inputs', () => {
    const repository = fileURLToPath(new URL('../../../', import.meta.url));

    test('covers every built workspace plus the assets the CLI build copies in', () => {
        for (const workspace of RENDERER_WORKSPACES) assert.ok(RENDERER_INPUT_PATHS.includes(workspace.directory), workspace.name);
        for (const asset of ['docker/launcher', '.env.example', 'package.json', 'package-lock.json']) {
            assert.ok(RENDERER_INPUT_PATHS.includes(asset), asset);
        }
    });

    test('omits generated output that a build writes back into the source tree', () => {
        // packages/cli/scripts/copy-assets.mjs writes into packages/cli/src and
        // tsc leaves .tsbuildinfo beside each tsconfig. Including either would
        // change the key on every build and make reuse impossible.
        const files = listSourceFiles(repository);
        assert.ok(Array.isArray(files) && files.length > 0);
        for (const generated of [
            'packages/cli/src/orchestrator/orchestrator.mjs',
            'packages/cli/src/orchestrator/manifest.json',
            'packages/cli/src/assets/env.example.txt',
        ]) {
            assert.ok(!files.includes(generated), generated);
        }
        assert.ok(!files.some(file => file.endsWith('.tsbuildinfo')), 'no incremental build state');
        assert.ok(!files.some(file => file.includes('/dist/') || file.includes('node_modules/')));
        assert.ok(files.includes('packages/shared/package.json'));
        assert.ok(files.includes('docker/launcher/orchestrator.mjs'));
    });

    test('declares the packaged CLI assets the desktop build depends on', () => {
        const cli = RENDERER_WORKSPACES.find(workspace => workspace.name === '@propr/cli');
        assert.ok(cli.outputs.includes('packages/cli/dist/skill/propr/SKILL.md'));
        for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
            assert.ok(cli.outputs.includes(`packages/cli/dist/native/prebuilds/${target}/directory-operations.node`), target);
        }
    });

    test('declares an output directory that contains every declared output', () => {
        for (const workspace of RENDERER_WORKSPACES) {
            assert.equal(workspace.outputDirectory, `${workspace.directory}/dist`, workspace.name);
            for (const output of workspace.outputs) {
                assert.ok(output.startsWith(`${workspace.outputDirectory}/`), output);
            }
            const compiler = JSON.parse(readFileSync(join(repository, workspace.directory, 'tsconfig.json'), 'utf8')).compilerOptions;
            assert.equal(compiler.outDir.replace(/^\.\//, ''), 'dist', workspace.name);
        }
    });

    test('matches the entry point each built workspace publishes', () => {
        for (const workspace of RENDERER_WORKSPACES) {
            const manifest = JSON.parse(readFileSync(join(repository, workspace.directory, 'package.json'), 'utf8'));
            assert.ok(workspace.outputs.includes(`${workspace.directory}/${manifest.main}`), workspace.name);
            assert.ok(workspace.outputs.includes(`${workspace.directory}/${manifest.types}`), workspace.name);
        }
    });
});
