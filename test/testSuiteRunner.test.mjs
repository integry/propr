import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
    NATIVE_WORKSPACE_PARTS,
    TIMEOUT_MARGIN_RATIO,
    buildManifest,
    buildTestArguments,
    buildWorkspaceCommand,
    discoverNativeWorkspaceTests,
    discoverTestFiles,
    discoverWorkspaceTestRoots,
    formatTimeoutRiskWarning,
    formatTimingReport,
    parseCliArguments,
    parseShardConfig,
    planRun,
    runSuite,
    runTestProcess,
    selectTestFiles,
    selectTimeoutRisks,
    shouldFlushRedis,
    unitKey,
    usesNativeWorkspaceTestRunner,
    verifyShardSummaries,
} from '../scripts/run-test-suite.mjs';
import { RENDERER_WORKSPACES } from '../apps/desktop/scripts/prepare-renderer.mjs';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));

function createFixtureRepository() {
    const root = mkdtempSync(join(tmpdir(), 'propr-runner-shards-'));
    mkdirSync(join(root, 'test'), { recursive: true });
    mkdirSync(join(root, 'packages', 'core', 'test'), { recursive: true });
    mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true });
    mkdirSync(join(root, 'apps', 'desktop', 'src'), { recursive: true });
    writeJson(join(root, 'package.json'), { workspaces: ['apps/*', 'packages/*'] });
    writeJson(join(root, 'packages', 'core', 'package.json'), { name: 'core' });
    writeJson(join(root, 'apps', 'web', 'package.json'), { name: 'web', scripts: { test: 'vitest run' } });
    writeJson(join(root, 'apps', 'desktop', 'package.json'), { name: 'desktop', scripts: { test: 'jest' } });
    for (let index = 0; index < 9; index += 1) writeFileSync(join(root, 'test', `root${index}.test.ts`), '');
    for (let index = 0; index < 4; index += 1) writeFileSync(join(root, 'packages', 'core', 'test', `core${index}.test.ts`), '');
    writeFileSync(join(root, 'test', 'e2e.test.ts'), '');
    writeFileSync(join(root, 'apps', 'web', 'src', 'native-owned.test.ts'), '');
    return root;
}

function passingSummary(plan, runAttempt = 1) {
    return {
        shard: plan.shard,
        runAttempt,
        interrupted: null,
        results: plan.units.map(({ kind, id }) => ({ kind, id, status: 'passed', durationMs: 1 })),
    };
}

describe('release test-suite runner', () => {
    test('prepares desktop runtime dependencies before clean desktop and full-suite tests', () => {
        const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        const desktopPackageUrl = new URL('../apps/desktop/package.json', import.meta.url);
        const desktopPackage = JSON.parse(readFileSync(desktopPackageUrl, 'utf8'));
        const workflow = readFileSync(new URL('../.github/workflows/pr-test-on-label.yml', import.meta.url), 'utf8');
        const sharedBuild = 'npm run build --workspace=packages/shared';
        const clientBuild = 'npm run build --workspace=packages/client';
        const fullSuitePreparation = rootPackage.scripts['test:prepare'];
        const desktopPreparation = desktopPackage.scripts['prepare:renderer'];

        assert.ok(fullSuitePreparation.indexOf(sharedBuild) >= 0);
        assert.ok(fullSuitePreparation.indexOf(clientBuild) > fullSuitePreparation.indexOf(sharedBuild));
        assert.equal(desktopPackage.scripts.pretest, 'npm run prepare:renderer');
        // The four builds moved into a script that reuses an identical build
        // within a job; their dependency order still has to hold.
        assert.equal(desktopPreparation, 'node scripts/prepare-renderer.mjs');
        const rendererOrder = RENDERER_WORKSPACES.map(workspace => workspace.name);
        assert.deepEqual(rendererOrder, ['@propr/shared', '@propr/local-setup', '@propr/cli', '@propr/client']);

        const cleanSharedDist = workflow.indexOf('test ! -e packages/shared/dist');
        const cleanClientDist = workflow.indexOf('test ! -e packages/client/dist');
        const prepareFullSuite = workflow.indexOf('npm run test:prepare', cleanClientDist);
        const assertSharedBuilt = workflow.indexOf('test -f packages/shared/dist/index.js', prepareFullSuite);
        const assertClientBuilt = workflow.indexOf('test -f packages/client/dist/index.js', prepareFullSuite);
        const runFullSuite = workflow.indexOf('npm run test:full:prepared', assertClientBuilt);
        assert.ok(cleanSharedDist >= 0);
        assert.ok(cleanClientDist > cleanSharedDist);
        assert.ok(prepareFullSuite > cleanClientDist);
        assert.ok(assertSharedBuilt > prepareFullSuite);
        assert.ok(assertClientBuilt > prepareFullSuite);
        assert.ok(runFullSuite > assertClientBuilt);
    });

    test('selects supported test files deterministically and excludes live E2E', () => {
        assert.deepEqual(selectTestFiles([
            '/repo/test/z.test.ts',
            '/repo/test/e2e.test.ts',
            '/repo/test/e2e/webhook.test.ts',
            '/repo/test/a.test.mjs',
            '/repo/test/helper.ts',
            '/repo/test/b.test.js',
            '/repo/test/component.test.tsx',
            '/repo/test/service.spec.ts',
        ]), [
            '/repo/test/a.test.mjs',
            '/repo/test/b.test.js',
            '/repo/test/component.test.tsx',
            '/repo/test/service.spec.ts',
            '/repo/test/z.test.ts',
        ]);
    });

    test('enables module mocking without hiding leaked resources behind forced exit', () => {
        assert.deepEqual(buildTestArguments('/repo/test/mock.test.ts'), [
            '--experimental-test-module-mocks',
            '--test',
            '/repo/test/mock.test.ts',
        ]);
    });

    test('requires an explicit flush opt-in before Redis isolation is destructive', () => {
        assert.equal(shouldFlushRedis(undefined), false);
        assert.equal(shouldFlushRedis('true'), false);
        assert.equal(shouldFlushRedis('off'), false);
        assert.equal(shouldFlushRedis(' FLUSH '), true);
    });

    test('waits for a timed-out process to close after escalating to SIGKILL', {
        skip: process.platform === 'win32',
    }, async () => {
        const result = await runTestProcess(process.execPath, [
            '-e',
            'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
        ], {
            stdio: 'ignore',
            // Give the child time to initialize its SIGTERM handler even when
            // the full test suite is running under CPU contention. A 100 ms
            // deadline could signal Node during startup and falsely observe a
            // normal SIGTERM exit instead of exercising hard-kill escalation.
            timeout: 1_000,
        }, () => {}, {
            terminationGraceMs: 50,
            forcedExitWaitMs: 500,
        });

        assert.equal(result.timedOut, true);
        assert.equal(result.signal, 'SIGKILL');
    });

    test('discovers root and workspace tests while delegating native workspace runners', () => {
        const root = mkdtempSync(join(tmpdir(), 'propr-runner-discovery-'));
        const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));
        try {
            mkdirSync(join(root, 'test'), { recursive: true });
            mkdirSync(join(root, 'packages', 'shared', 'test'), { recursive: true });
            mkdirSync(join(root, 'apps', 'service', 'src'), { recursive: true });
            mkdirSync(join(root, 'apps', 'narrow', 'src'), { recursive: true });
            mkdirSync(join(root, 'web-client', 'src'), { recursive: true });
            writeJson(join(root, 'package.json'), { workspaces: ['apps/*', 'packages/*', 'web-client'] });
            writeJson(join(root, 'packages', 'shared', 'package.json'), { name: '@propr/shared' });
            writeJson(join(root, 'apps', 'service', 'package.json'), { name: 'service' });
            writeJson(join(root, 'apps', 'narrow', 'package.json'), { name: 'narrow', scripts: { test: 'node --test one.test.ts' } });
            writeJson(join(root, 'web-client', 'package.json'), { name: 'web-client', scripts: { test: 'vitest run' } });
            writeFileSync(join(root, 'test', 'root.test.ts'), '');
            writeFileSync(join(root, 'packages', 'shared', 'test', 'shared.test.ts'), '');
            writeFileSync(join(root, 'apps', 'service', 'src', 'service.spec.ts'), '');
            writeFileSync(join(root, 'apps', 'narrow', 'src', 'otherwise-omitted.test.ts'), '');
            writeFileSync(join(root, 'web-client', 'src', 'ui.test.ts'), '');

            assert.deepEqual(discoverWorkspaceTestRoots(root), [
                join(root, 'apps', 'narrow'),
                join(root, 'apps', 'service'),
                join(root, 'packages', 'shared'),
                join(root, 'test'),
            ]);
            assert.deepEqual(discoverNativeWorkspaceTests(root), ['web-client']);
            assert.deepEqual(discoverTestFiles([], root), [
                join(root, 'apps', 'narrow', 'src', 'otherwise-omitted.test.ts'),
                join(root, 'apps', 'service', 'src', 'service.spec.ts'),
                join(root, 'packages', 'shared', 'test', 'shared.test.ts'),
                join(root, 'test', 'root.test.ts'),
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('delegates native workspace runners by script instead of package name', () => {
        assert.equal(usesNativeWorkspaceTestRunner({ name: 'web', scripts: { test: 'vitest run' } }), true);
        assert.equal(usesNativeWorkspaceTestRunner({ name: 'api', scripts: { test: 'jest --runInBand' } }), true);
        assert.equal(usesNativeWorkspaceTestRunner({ name: 'service', scripts: { test: 'node --test one.test.ts' } }), false);
        assert.equal(usesNativeWorkspaceTestRunner({ name: 'shared' }), false);
    });
    test('partitions every discovered file and native workspace part into exactly one shard', () => {
        const root = createFixtureRepository();
        try {
            const unsharded = planRun({ root });
            const allKeys = unsharded.allUnits.map(unitKey);
            assert.equal(allKeys.length, 21);
            for (const workspace of ['apps/desktop', 'apps/web']) {
                for (let part = 1; part <= NATIVE_WORKSPACE_PARTS; part += 1) {
                    assert.ok(allKeys.includes(`workspace:${workspace}#${part}/${NATIVE_WORKSPACE_PARTS}`));
                }
            }
            assert.ok(!allKeys.includes('workspace:apps/web'), 'a native workspace never runs whole');
            assert.ok(!allKeys.some(key => key.includes('e2e.test.ts')));
            assert.ok(!allKeys.some(key => key.includes('native-owned')), 'native workspace files belong to their workspace runner');

            for (const count of [1, 2, 3, 4, 7]) {
                const owners = new Map();
                for (let index = 1; index <= count; index += 1) {
                    const shard = planRun({ root, shard: { index, count } });
                    assert.deepEqual(shard.allUnits, unsharded.allUnits);
                    assert.deepEqual(planRun({ root, shard: { index, count } }).units, shard.units, 'assignment must be deterministic');
                    for (const unit of shard.units) {
                        assert.equal(owners.has(unitKey(unit)), false, `${unitKey(unit)} assigned twice for ${count} shards`);
                        owners.set(unitKey(unit), index);
                    }
                    const sizes = shard.units.length;
                    assert.ok(sizes >= Math.floor(21 / count) && sizes <= Math.ceil(21 / count));
                }
                assert.deepEqual([...owners.keys()].sort(), [...allKeys].sort());
            }
            assert.deepEqual(planRun({ root, shard: null }).units, unsharded.allUnits);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('partitions the real repository suite completely across the CI shard count', () => {
        const unsharded = planRun();
        const nativeWorkspaces = discoverNativeWorkspaceTests();
        assert.ok(nativeWorkspaces.length > 0);
        const summaries = [1, 2, 3, 4].map(index => passingSummary(planRun({ shard: { index, count: 4 } })));
        const verification = verifyShardSummaries(summaries, unsharded.allUnits, 4);
        assert.deepEqual(verification.errors, []);
        assert.equal(verification.units, unsharded.allUnits.length);
        const workspaceParts = summaries.map(summary => summary.results.filter(result => result.kind === 'workspace').map(result => result.id));
        assert.deepEqual(workspaceParts.flat().sort(), nativeWorkspaces.flatMap(workspace => (
            Array.from({ length: NATIVE_WORKSPACE_PARTS }, (_value, index) => `${workspace}#${index + 1}/${NATIVE_WORKSPACE_PARTS}`)
        )).sort());
        // propr-ui outlasted the per-unit timeout as one unit on a two-CPU
        // worker; its parts must spread across the CI shards.
        assert.ok(workspaceParts.every(parts => parts.length === nativeWorkspaces.length), JSON.stringify(workspaceParts));
    });

    test('runs each native workspace part through the package runner shard option', () => {
        const [part] = planRun().allUnits.filter(unit => unit.kind === 'workspace');
        assert.deepEqual(part, { kind: 'workspace', id: `propr-ui#1/${NATIVE_WORKSPACE_PARTS}`, workspace: 'propr-ui', part: `1/${NATIVE_WORKSPACE_PARTS}` });
        assert.deepEqual(buildWorkspaceCommand(part, 'linux'), ['npm', ['test', '--workspace=propr-ui', '--', `--shard=1/${NATIVE_WORKSPACE_PARTS}`]]);
        assert.equal(buildWorkspaceCommand(part, 'win32')[0], 'npm.cmd');
    });

    test('rejects invalid or partial shard configuration', () => {
        assert.equal(parseShardConfig({}), null);
        assert.equal(parseShardConfig({ index: '', count: '' }), null);
        assert.deepEqual(parseShardConfig({ index: '2', count: '4' }), { index: 2, count: 4 });
        for (const [config, message] of [
            [{ index: '1' }, /set together/],
            [{ count: '4' }, /set together/],
            [{ index: '0', count: '4' }, /Shard index must be a positive integer/],
            [{ index: '5', count: '4' }, /outside 1\.\.4/],
            [{ index: '1', count: '0' }, /Shard count must be a positive integer/],
            [{ index: '01', count: '4' }, /positive integer/],
            [{ index: '1.5', count: '4' }, /positive integer/],
            [{ index: ' 1', count: '4' }, /positive integer/],
            [{ index: '-1', count: '4' }, /positive integer/],
            [{ index: 'one', count: '4' }, /positive integer/],
            [{ index: '1', count: '65' }, /must not exceed 64/],
        ]) {
            assert.throws(() => parseShardConfig(config), message, JSON.stringify(config));
        }
        assert.deepEqual(parseCliArguments(['--shard=3/4', '--list']).shard, { index: '3', count: '4' });
        assert.throws(() => parseCliArguments(['--shard=3']), /INDEX\/COUNT/);
        assert.throws(() => parseCliArguments(['--shard=1/2/3']), /INDEX\/COUNT/);
        assert.throws(() => parseCliArguments(['--shards=1/2']), /Unknown option/);
        assert.throws(() => planRun({ requestedFiles: ['test/minimal.test.ts'], shard: { index: 1, count: 2 } }), /cannot be combined/);
    });

    test('rejects shards that would run nothing and conflicting shard sources', async () => {
        const root = createFixtureRepository();
        try {
            assert.throws(() => planRun({ root, shard: { index: 32, count: 32 } }), /has no test units/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
        await assert.rejects(
            runSuite(['--list', '--shard=1/4'], { PROPR_TEST_SHARD_INDEX: '1', PROPR_TEST_SHARD_COUNT: '4' }),
            /either --shard or PROPR_TEST_SHARD_INDEX/,
        );
        await assert.rejects(runSuite(['--list'], { PROPR_TEST_SHARD_INDEX: '2' }), /set together/);
    });

    test('lists a shard manifest without running tests', () => {
        const root = createFixtureRepository();
        try {
            const manifest = buildManifest(planRun({ root, shard: { index: 2, count: 4 } }));
            assert.deepEqual(manifest.shard, { index: 2, count: 4 });
            assert.equal(manifest.totalUnits, 21);
            assert.ok(manifest.units.every(unit => Object.keys(unit).sort().join() === 'id,kind'));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
        const listed = spawnSync(process.execPath, ['scripts/run-test-suite.mjs', '--list', '--shard=4/4'], {
            cwd: new URL('..', import.meta.url),
            encoding: 'utf8',
            env: { ...process.env, PROPR_TEST_SHARD_INDEX: '', PROPR_TEST_SHARD_COUNT: '' },
        });
        assert.equal(listed.status, 0, listed.stderr);
        assert.deepEqual(JSON.parse(listed.stdout).shard, { index: 4, count: 4 });
    });

    test('verifies shard summaries cover the suite exactly once', () => {
        const root = createFixtureRepository();
        try {
            const { allUnits } = planRun({ root });
            const plans = [1, 2, 3].map(index => planRun({ root, shard: { index, count: 3 } }));
            const summaries = plans.map(plan => passingSummary(plan));
            assert.equal(verifyShardSummaries(summaries, allUnits, 3).ok, true);

            const missingShard = verifyShardSummaries(summaries.slice(0, 2), allUnits, 3);
            assert.equal(missingShard.ok, false);
            assert.ok(missingShard.errors.includes('shard 3/3 did not report a summary'));
            assert.ok(missingShard.errors.some(error => error.endsWith('did not run in any shard')));

            const truncated = structuredClone(summaries);
            const dropped = truncated[0].results.pop();
            assert.ok(verifyShardSummaries(truncated, allUnits, 3).errors.includes(`${unitKey(dropped)} did not run in any shard`));

            const duplicated = structuredClone(summaries);
            duplicated[1].results.push(duplicated[0].results[0]);
            assert.ok(verifyShardSummaries(duplicated, allUnits, 3).errors.some(error => error.includes('ran in shard 1 and shard 2')));

            const extra = structuredClone(summaries);
            extra[2].results.push({ kind: 'file', id: 'test/stale.test.ts', status: 'passed', durationMs: 1 });
            assert.ok(verifyShardSummaries(extra, allUnits, 3).errors.includes('file:test/stale.test.ts ran but is not part of the discovered suite'));

            assert.ok(verifyShardSummaries(summaries, allUnits, 4).errors.some(error => error.includes('expected count 4')));
            assert.ok(verifyShardSummaries([...summaries, summaries[0]], allUnits, 3).errors.includes('shard 1/3 reported more than once'));

            const interrupted = structuredClone(summaries);
            interrupted[1].interrupted = 'SIGTERM';
            assert.ok(verifyShardSummaries(interrupted, allUnits, 3).errors.includes('shard 2/3 was interrupted'));

            // Re-running a failed shard keeps passing shards from attempt 1;
            // the newest attempt of each shard is the one that counts.
            const staleAttempt = structuredClone(summaries[1]);
            staleAttempt.interrupted = 'SIGTERM';
            const rerun = passingSummary(plans[1], 2);
            assert.equal(verifyShardSummaries([summaries[0], staleAttempt, rerun, summaries[2]], allUnits, 3).ok, true);
            assert.equal(verifyShardSummaries([summaries[0], rerun, staleAttempt, summaries[2]], allUnits, 3).ok, true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('reports per-unit timing for later shard balancing', () => {
        const report = formatTimingReport({
            shard: { index: 1, count: 4 },
            totalUnits: 9,
            durationMs: 4500,
            passed: 2,
            results: [
                { kind: 'file', id: 'test/fast.test.ts', status: 'passed', durationMs: 500 },
                { kind: 'workspace', id: 'propr-ui#2/4', status: 'failed', durationMs: 3000 },
                { kind: 'file', id: 'test/medium.test.ts', status: 'passed', durationMs: 1000 },
            ],
        }, 2);
        assert.match(report, /Shard 1\/4: 2\/3 passed in 4\.5s/);
        assert.match(report, /Assigned 3 of 9 discovered units/);
        const rows = report.split('\n').filter(line => line.startsWith('| ') && line.includes('`'));
        assert.deepEqual(rows, [
            '| 3.0s | failed | `propr-ui#2/4` (workspace) |',
            '| 1.0s | passed | `test/medium.test.ts` |',
        ]);
        assert.doesNotMatch(report, /per-unit timeout/, 'a report without a timeout budget stays quiet');
    });

    // propr-ui stayed healthy and simply grew until it outlasted the per-unit
    // timeout and failed the nightly suite. A unit that already spends most of
    // its budget is reported while it still passes.
    test('warns about passing units that are close to the per-unit timeout', () => {
        const summary = {
            shard: null,
            timeoutMs: 180_000,
            totalUnits: 4,
            durationMs: 300_000,
            passed: 3,
            results: [
                { kind: 'file', id: 'test/quick.test.ts', status: 'passed', durationMs: 107_999 },
                { kind: 'workspace', id: 'propr-ui#2/4', status: 'passed', durationMs: 108_000 },
                { kind: 'file', id: 'test/slow.test.ts', status: 'passed', durationMs: 171_000 },
                { kind: 'workspace', id: 'propr-ui#3/4', status: 'failed', durationMs: 180_000 },
            ],
        };

        assert.equal(TIMEOUT_MARGIN_RATIO, 0.6);
        // The unit that timed out is left to the failure list; the units that
        // still pass are the ones worth splitting now.
        assert.deepEqual(selectTimeoutRisks(summary).map(result => result.id), ['test/slow.test.ts', 'propr-ui#2/4']);
        assert.deepEqual(selectTimeoutRisks(summary, 0.9).map(result => result.id), ['test/slow.test.ts']);
        assert.deepEqual(selectTimeoutRisks({ ...summary, timeoutMs: undefined }), [], 'no budget, nothing to measure against');

        const report = formatTimingReport(summary);
        assert.match(report, /Passing units at or above 60% of the 180\.0s per-unit timeout\. Split or speed these up before they fail:/);
        assert.match(report, /^- `test\/slow\.test\.ts` used 95% \(171\.0s\)$/m);
        assert.match(report, /^- `propr-ui#2\/4` used 60% \(108\.0s\)$/m);
        assert.doesNotMatch(report, /^- `test\/quick\.test\.ts`/m);
        assert.doesNotMatch(report, /^- `propr-ui#3\/4`/m);

        const [risk] = selectTimeoutRisks(summary);
        assert.equal(
            formatTimeoutRiskWarning(risk, summary.timeoutMs, { GITHUB_ACTIONS: 'true' }),
            '::warning title=Test unit near the per-unit timeout::test/slow.test.ts used 95% (171.0s) of the 180.0s per-unit timeout',
        );
        assert.equal(
            formatTimeoutRiskWarning(risk, summary.timeoutMs, {}),
            'Warning: test/slow.test.ts used 95% (171.0s) of the 180.0s per-unit timeout',
        );
    });

    test('records the per-unit timeout every unit was measured against', () => {
        const summaryDirectory = mkdtempSync(join(tmpdir(), 'propr-runner-summary-'));
        const summaryFile = join(summaryDirectory, 'summary.json');
        const env = {
            ...process.env,
            PROPR_TEST_SHARD_INDEX: '',
            PROPR_TEST_SHARD_COUNT: '',
            PROPR_TEST_REDIS_ISOLATION: '',
            // An inherited override would make the nested run record its own
            // budget; this test is about the default one.
            PROPR_TEST_TIMEOUT_MS: '',
            PROPR_TEST_SUMMARY_FILE: summaryFile,
            GITHUB_STEP_SUMMARY: '',
            GITHUB_ACTIONS: '',
        };
        // Inheriting this file's own test-runner marker would make the nested
        // run skip the test file instead of executing it.
        delete env.NODE_TEST_CONTEXT;
        try {
            const run = spawnSync(process.execPath, ['scripts/run-test-suite.mjs', 'test/minimal.test.ts'], {
                cwd: new URL('..', import.meta.url),
                encoding: 'utf8',
                env,
            });
            assert.equal(run.status, 0, run.stderr);
            const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
            assert.equal(summary.timeoutMs, 180_000);
            assert.equal(summary.results.length, 1);
            assert.deepEqual(selectTimeoutRisks(summary), [], 'a fast unit must not be reported as near the timeout');
            assert.doesNotMatch(run.stdout, /per-unit timeout/);
            assert.doesNotMatch(run.stderr, /Warning:/);
        } finally {
            rmSync(summaryDirectory, { recursive: true, force: true });
        }
    });

    test('hands every unit the desktop fsync opt-out unless the caller set it explicitly', () => {
        const probeDirectory = mkdtempSync(join(tmpdir(), 'propr-runner-fsync-'));
        const recordFile = join(probeDirectory, 'fsync-variable.txt');
        const probeFile = join(probeDirectory, 'env-probe.test.mjs');
        // The probe is a fixed source string: it learns where to record from
        // its environment rather than having the temp path spliced into code.
        writeFileSync(probeFile, [
            "import { writeFileSync } from 'node:fs';",
            "import { test } from 'node:test';",
            "test('records the fsync variable', () => writeFileSync(process.env.PROPR_FSYNC_PROBE_RECORD_FILE, String(process.env.PROPR_DESKTOP_TEST_FSYNC)));",
            '',
        ].join('\n'));
        const baseEnv = {
            ...process.env,
            PROPR_FSYNC_PROBE_RECORD_FILE: recordFile,
            PROPR_TEST_SHARD_INDEX: '',
            PROPR_TEST_SHARD_COUNT: '',
            PROPR_TEST_REDIS_ISOLATION: '',
            PROPR_TEST_SUMMARY_FILE: '',
            GITHUB_STEP_SUMMARY: '',
            GITHUB_ACTIONS: '',
        };
        delete baseEnv.NODE_TEST_CONTEXT;
        delete baseEnv.PROPR_DESKTOP_TEST_FSYNC;
        const runProbe = env => {
            rmSync(recordFile, { force: true });
            const run = spawnSync(process.execPath, ['scripts/run-test-suite.mjs', probeFile], {
                cwd: new URL('..', import.meta.url),
                encoding: 'utf8',
                env,
            });
            assert.equal(run.status, 0, run.stderr);
            return readFileSync(recordFile, 'utf8');
        };
        try {
            // The shared runner's disk makes native fsync too slow for the
            // desktop profile-store suites; the full suite opts them out.
            assert.equal(runProbe(baseEnv), 'off');
            // The native durability jobs and any explicit choice win.
            assert.equal(runProbe({ ...baseEnv, PROPR_DESKTOP_TEST_FSYNC: 'native' }), 'native');
        } finally {
            rmSync(probeDirectory, { recursive: true, force: true });
        }
    });

    test('keeps the four-shard matrix complete and isolated on either route', () => {
        const workflow = readFileSync(new URL('../.github/workflows/pr-test-on-label.yml', import.meta.url), 'utf8');
        const shardCount = Number(workflow.match(/PROPR_TEST_SHARD_COUNT: '(\d+)'/)[1]);
        const matrix = workflow.match(/shard: \[([\d, ]+)\]/)[1].split(',').map(Number);
        assert.deepEqual(matrix, Array.from({ length: shardCount }, (_value, index) => index + 1));
        assert.match(workflow, /name: Full Test Suite Shard \$\{\{ matrix\.shard \}\}\/4\n/);
        assert.equal(shardCount, 4);
        assert.match(workflow, /fail-fast: false/);
        assert.match(workflow, /cancel-in-progress: true/);
        assert.doesNotMatch(workflow, /secrets\./, 'PR full-suite jobs must stay secretless');
        assert.match(workflow, /PROPR_TEST_SHARD_INDEX: \$\{\{ matrix\.shard \}\}/);
        assert.match(workflow, /name: full-test-output-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-shard-\$\{\{ matrix\.shard \}\}/);
        // Matrix entries share GITHUB_JOB, so each names its own Redis instance
        // for both start and stop.
        assert.equal(workflow.match(/CI_REDIS_INSTANCE: shard-\$\{\{ matrix\.shard \}\}\n\s+run: \.\/scripts\/ci-redis\.sh (?:start|stop)/g).length, 2);
        assert.match(workflow, /scripts\/sanitize-ci-output\.mjs test_output\.txt shard-output\/test_output\.sanitized\.txt/);
        assert.equal(workflow.match(/\.\/\.propr\/setup\.sh/g).length, 1, 'docs validation runs once, not per shard');

        const shardJob = workflow.slice(workflow.indexOf('\n  shard:\n'), workflow.indexOf('\n  docs:\n'));
        assert.match(shardJob, /runs-on: \$\{\{ fromJSON\(vars\.PROPR_ROOTLESS_PR_CHECKS == 'true'/, 'self-hosted routing requires explicit activation');
        const gate = workflow.slice(workflow.indexOf('\n  test:\n'), workflow.indexOf('\n  comment:\n'));
        assert.match(gate, /name: Run Full Test Suite\n/);
        assert.match(gate, /always\(\) &&\s+\(github\.event_name == 'workflow_dispatch' \|\| !github\.event\.pull_request\.draft\)/);
        assert.match(gate, /--verify-shard-summaries/);
        for (const job of ['shard', 'docs']) {
            const start = workflow.indexOf(`\n  ${job}:\n`);
            const header = workflow.slice(start, workflow.indexOf('steps:', start));
            assert.match(header, /github\.event_name == 'workflow_dispatch' \|\| !github\.event\.pull_request\.draft/, `${job} skips draft PRs`);
        }
        // Routing semantics and gate enforcement are covered in test/ciRunnerRouting.test.mjs.
    });

    test('serializes nightly validation without cancelling an active live run', () => {
        const workflow = readFileSync(new URL('../.github/workflows/test-nightly.yml', import.meta.url), 'utf8');
        const concurrency = workflow.slice(workflow.indexOf('\nconcurrency:\n'), workflow.indexOf('\njobs:\n'));
        assert.match(concurrency, /^  group: nightly-test-suite$/m);
        assert.match(concurrency, /cancel-in-progress: false/);
        assert.doesNotMatch(workflow, /PROPR_TEST_SHARD_/, 'nightly keeps the unsharded full suite');
        assert.match(workflow, /npm run test:full:prepared/);
        assert.match(workflow, /npm run test:e2e/);
    });
});
