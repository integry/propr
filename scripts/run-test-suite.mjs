#!/usr/bin/env node

// Runs the non-live test suite one file (or native workspace part) at a time.
//
//   node scripts/run-test-suite.mjs [files...]    run all or the given files
//   --shard=INDEX/COUNT                           run one deterministic shard of the
//                                                 full suite (or PROPR_TEST_SHARD_INDEX
//                                                 and PROPR_TEST_SHARD_COUNT)
//   --list                                        print the unit manifest and exit
//   --verify-shard-summaries <summary.json...>    prove PROPR_TEST_SHARD_COUNT shard
//                                                 summaries ran every unit exactly once
//
// PROPR_TEST_SUMMARY_FILE receives per-unit status and timing as JSON.
// PROPR_TEST_TIMEOUT_MS bounds every unit; units that pass but already use
// most of that budget are reported before they start timing out.
// PROPR_DESKTOP_TEST_FSYNC defaults to 'off' for every unit: the desktop
// profile-store suites then skip native fsync, which the shared-disk runner
// serves too slowly for that budget. The native durability jobs run those
// files directly and keep real fsync. An explicit value is passed through.

import { appendFileSync, existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_TIMEOUT_MS = 180_000;
const TERMINATION_GRACE_MS = 2_000;
const FORCED_EXIT_WAIT_MS = 2_000;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const EXCLUDED_TESTS = new Set(['e2e.test.ts']);
const IGNORED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const MAX_SHARD_COUNT = 64;
const SHARD_NUMBER_PATTERN = /^[1-9][0-9]*$/;
const SLOWEST_RUNS_REPORTED = 15;
// A unit that already spends most of its budget is one slow test file, or one
// contended nightly run, away from being killed. propr-ui crossed the per-unit
// timeout that way: it stayed healthy and just kept growing until the nightly
// suite failed with no earlier signal. Passing units at or above this share of
// the timeout are reported so they can be split before they fail.
export const TIMEOUT_MARGIN_RATIO = 0.6;
// Each native Jest/Vitest workspace runs as this many `--shard` parts. As one
// unit, propr-ui alone took 88s on a hosted runner and more than the per-unit
// timeout on a worker limited to two CPUs. Parts keep every unit well inside
// the timeout and let consecutive parts land in different CI shards.
export const NATIVE_WORKSPACE_PARTS = 4;

export function usesNativeWorkspaceTestRunner(workspacePackage) {
    const testScript = workspacePackage.scripts?.test;
    return typeof testScript === 'string' && /\b(?:jest|vitest)\b/.test(testScript);
}

function isLiveTest(entry) {
    const normalized = entry.replaceAll('\\', '/');
    return EXCLUDED_TESTS.has(basename(normalized)) || normalized.includes('/test/e2e/');
}

export function selectTestFiles(entries) {
    return entries
        .filter(entry => TEST_FILE_PATTERN.test(entry))
        .filter(entry => !isLiveTest(entry))
        .sort((a, b) => a.localeCompare(b));
}

export function buildTestArguments(testFile) {
    return [
        '--experimental-test-module-mocks',
        '--test',
        testFile,
    ];
}

function parseTimeout(value) {
    if (value === undefined || value === '') return DEFAULT_TIMEOUT_MS;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error('PROPR_TEST_TIMEOUT_MS must be a positive integer');
    }
    return parsed;
}

function readPackageJson(directory) {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
}

function expandWorkspacePattern(root, pattern) {
    if (!pattern.endsWith('/*')) {
        const workspace = resolve(root, pattern);
        return existsSync(join(workspace, 'package.json')) ? [workspace] : [];
    }
    const parent = resolve(root, pattern.slice(0, -2));
    if (!existsSync(parent)) return [];
    return readdirSync(parent, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(parent, entry.name))
        .filter(directory => existsSync(join(directory, 'package.json')));
}

function discoverWorkspaces(root) {
    const rootPackage = readPackageJson(root);
    const workspacePatterns = Array.isArray(rootPackage.workspaces)
        ? rootPackage.workspaces
        : rootPackage.workspaces?.packages ?? [];
    return workspacePatterns
        .flatMap(pattern => expandWorkspacePattern(root, pattern))
        .map(directory => ({ directory, package: readPackageJson(directory) }));
}

export function discoverNativeWorkspaceTests(root = ROOT) {
    return discoverWorkspaces(root)
        .filter(workspace => usesNativeWorkspaceTestRunner(workspace.package))
        .map(workspace => relative(root, workspace.directory).replaceAll('\\', '/'))
        .sort((a, b) => a.localeCompare(b));
}

export function discoverWorkspaceTestRoots(root = ROOT) {
    const roots = [join(root, 'test')];

    for (const { directory, package: workspacePackage } of discoverWorkspaces(root)) {
        // Jest/Vitest suites need their package-native environment and are run
        // by this runner after Node-compatible files. Node-compatible workspace
        // files remain exclusively owned here, even when that workspace also
        // exposes a narrow Node-based test script.
        if (usesNativeWorkspaceTestRunner(workspacePackage)) continue;
        roots.push(directory);
    }

    return [...new Set(roots.filter(existsSync))].sort((a, b) => a.localeCompare(b));
}

function visitFiles(directory, discovered) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visitFiles(path, discovered);
        else if (entry.isFile()) discovered.push(path);
    }
}

export function discoverTestFiles(requestedFiles, root = ROOT) {
    if (requestedFiles.length > 0) {
        return selectTestFiles(requestedFiles.map(file => resolve(root, file)));
    }

    const discovered = [];
    for (const testRoot of discoverWorkspaceTestRoots(root)) visitFiles(testRoot, discovered);
    return selectTestFiles(discovered);
}

function parseShardNumber(value, name) {
    if (typeof value !== 'string' || !SHARD_NUMBER_PATTERN.test(value)) {
        throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
    }
    return Number(value);
}

// Shard configuration is all-or-nothing: an index without a count (or the
// reverse) would silently run the wrong subset, so it is rejected.
export function parseShardConfig({ index, count } = {}) {
    const hasIndex = index !== undefined && index !== '';
    const hasCount = count !== undefined && count !== '';
    if (!hasIndex && !hasCount) return null;
    if (!hasIndex || !hasCount) {
        throw new Error('Shard index and count must be set together (--shard=INDEX/COUNT or PROPR_TEST_SHARD_INDEX and PROPR_TEST_SHARD_COUNT)');
    }
    const shardIndex = parseShardNumber(index, 'Shard index');
    const shardCount = parseShardNumber(count, 'Shard count');
    if (shardCount > MAX_SHARD_COUNT) {
        throw new Error(`Shard count must not exceed ${MAX_SHARD_COUNT}, got ${shardCount}`);
    }
    if (shardIndex > shardCount) {
        throw new Error(`Shard index ${shardIndex} is outside 1..${shardCount}`);
    }
    return { index: shardIndex, count: shardCount };
}

export function parseCliArguments(argv) {
    const files = [];
    let list = false;
    let verifyShardSummaries = null;
    let shard = {};
    for (let position = 0; position < argv.length; position += 1) {
        const argument = argv[position];
        if (argument === '--list') {
            list = true;
        } else if (argument.startsWith('--shard=')) {
            const [index, count, ...rest] = argument.slice('--shard='.length).split('/');
            if (rest.length > 0 || count === undefined) {
                throw new Error(`--shard must use the form INDEX/COUNT, got ${JSON.stringify(argument)}`);
            }
            shard = { index, count };
        } else if (argument === '--verify-shard-summaries') {
            verifyShardSummaries = argv.slice(position + 1);
            if (verifyShardSummaries.length === 0) {
                throw new Error('--verify-shard-summaries requires at least one summary file');
            }
            break;
        } else if (argument.startsWith('--')) {
            throw new Error(`Unknown option ${argument}`);
        } else {
            files.push(argument);
        }
    }
    return { files, list, shard, verifyShardSummaries };
}

// A test run unit is either one Node-compatible test file or one `--shard`
// part of a native Jest/Vitest workspace. Identifiers are repository-relative
// so manifests from different machines and checkouts are comparable.
export function buildRunUnits(testFiles, nativeWorkspaces, root = ROOT) {
    return [
        ...testFiles.map(file => ({ kind: 'file', id: relative(root, file).replaceAll('\\', '/'), path: file })),
        ...nativeWorkspaces.flatMap(workspace => Array.from({ length: NATIVE_WORKSPACE_PARTS }, (_value, position) => {
            const part = `${position + 1}/${NATIVE_WORKSPACE_PARTS}`;
            return { kind: 'workspace', id: `${workspace}#${part}`, workspace, part };
        })),
    ];
}

export function buildWorkspaceCommand(unit, platform = process.platform) {
    return [
        platform === 'win32' ? 'npm.cmd' : 'npm',
        ['test', `--workspace=${unit.workspace}`, '--', `--shard=${unit.part}`],
    ];
}

export function unitKey(unit) {
    return `${unit.kind}:${unit.id}`;
}

// Deterministic round-robin over the sorted unit list. Every unit lands in
// exactly one shard and the assignment depends only on the discovered set,
// never on timing, so any job can recompute the complete partition.
export function selectShardUnits(units, shard) {
    if (!shard) return units;
    return units.filter((_unit, position) => position % shard.count === shard.index - 1);
}

export function planRun({ requestedFiles = [], shard = null, root = ROOT } = {}) {
    if (shard && requestedFiles.length > 0) {
        throw new Error('Sharding applies to full-suite discovery and cannot be combined with explicit test files');
    }
    const testFiles = discoverTestFiles(requestedFiles, root);
    const nativeWorkspaces = requestedFiles.length === 0 ? discoverNativeWorkspaceTests(root) : [];
    const allUnits = buildRunUnits(testFiles, nativeWorkspaces, root);
    if (allUnits.length === 0) throw new Error('No non-live test files matched');
    const units = selectShardUnits(allUnits, shard);
    if (units.length === 0) {
        throw new Error(`Shard ${shard.index}/${shard.count} has no test units; lower the shard count`);
    }
    return { allUnits, units, shard };
}

export function buildManifest(plan) {
    return {
        schemaVersion: 1,
        shard: plan.shard,
        totalUnits: plan.allUnits.length,
        units: plan.units.map(({ kind, id }) => ({ kind, id })),
    };
}

// Proves that the per-shard summaries together executed the complete suite:
// every expected shard reported, every discovered unit ran in exactly one
// shard, and no shard ran a unit outside the current discovery.
// Re-running only failed jobs keeps earlier attempts' passing shard
// summaries, so the newest attempt of each shard index is authoritative.
export function selectLatestShardAttempts(summaries) {
    const latest = new Map();
    const selected = [];
    for (const summary of summaries) {
        const index = summary?.shard?.index;
        if (index === undefined) {
            selected.push(summary);
            continue;
        }
        const attempt = summary.runAttempt ?? 1;
        const current = latest.get(index);
        if (!current || attempt > current.attempt) latest.set(index, { attempt, summaries: [summary] });
        else if (attempt === current.attempt) current.summaries.push(summary);
    }
    for (const { summaries: attemptSummaries } of latest.values()) selected.push(...attemptSummaries);
    return selected;
}

export function verifyShardSummaries(summaries, expectedUnits, expectedCount) {
    const errors = [];
    const seenShards = new Map();
    const owners = new Map();
    for (const summary of selectLatestShardAttempts(summaries)) {
        const shard = summary?.shard;
        if (!shard || shard.count !== expectedCount) {
            errors.push(`summary reports shard ${JSON.stringify(shard)}; expected count ${expectedCount}`);
            continue;
        }
        if (seenShards.has(shard.index)) {
            errors.push(`shard ${shard.index}/${expectedCount} reported more than once`);
            continue;
        }
        seenShards.set(shard.index, summary);
        if (summary.interrupted) errors.push(`shard ${shard.index}/${expectedCount} was interrupted`);
        for (const result of summary.results ?? []) {
            const key = unitKey(result);
            const previous = owners.get(key);
            if (previous !== undefined) {
                errors.push(`${key} ran in shard ${previous} and shard ${shard.index}`);
            } else {
                owners.set(key, shard.index);
            }
        }
    }
    for (let index = 1; index <= expectedCount; index += 1) {
        if (!seenShards.has(index)) errors.push(`shard ${index}/${expectedCount} did not report a summary`);
    }
    const expectedKeys = new Set(expectedUnits.map(unitKey));
    for (const key of expectedKeys) {
        if (!owners.has(key)) errors.push(`${key} did not run in any shard`);
    }
    for (const key of owners.keys()) {
        if (!expectedKeys.has(key)) errors.push(`${key} ran but is not part of the discovered suite`);
    }
    return { ok: errors.length === 0, errors, shards: seenShards.size, units: owners.size };
}

export function formatDuration(milliseconds) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
}

function formatBudgetShare(durationMs, timeoutMs) {
    return `${Math.round((durationMs / timeoutMs) * 100)}%`;
}

// Units that passed but are already close to the per-unit timeout. A failed
// unit is reported by the failure list, so repeating it here would only bury
// the units that still have a chance of being split in time.
export function selectTimeoutRisks(summary, ratio = TIMEOUT_MARGIN_RATIO) {
    if (!summary.timeoutMs) return [];
    return summary.results
        .filter(result => result.status === 'passed' && result.durationMs >= summary.timeoutMs * ratio)
        .sort((a, b) => b.durationMs - a.durationMs || a.id.localeCompare(b.id));
}

// Annotated on GitHub Actions so the warning is visible on the run itself
// rather than only in the log of an otherwise green job.
export function formatTimeoutRiskWarning(result, timeoutMs, env = process.env) {
    const message = `${result.id} used ${formatBudgetShare(result.durationMs, timeoutMs)} `
        + `(${formatDuration(result.durationMs)}) of the ${formatDuration(timeoutMs)} per-unit timeout`;
    return env.GITHUB_ACTIONS === 'true'
        ? `::warning title=Test unit near the per-unit timeout::${message}`
        : `Warning: ${message}`;
}

export function formatTimingReport(summary, limit = SLOWEST_RUNS_REPORTED) {
    const label = summary.shard ? `Shard ${summary.shard.index}/${summary.shard.count}` : 'Unsharded suite';
    const slowest = [...summary.results]
        .sort((a, b) => b.durationMs - a.durationMs || a.id.localeCompare(b.id))
        .slice(0, limit);
    const risks = selectTimeoutRisks(summary);
    return [
        `### ${label}: ${summary.passed}/${summary.results.length} passed in ${formatDuration(summary.durationMs)}`,
        '',
        `Assigned ${summary.results.length} of ${summary.totalUnits} discovered units.`,
        '',
        '| Duration | Status | Unit |',
        '| ---: | --- | --- |',
        ...slowest.map(result => `| ${formatDuration(result.durationMs)} | ${result.status} | \`${result.id}\`${result.kind === 'workspace' ? ' (workspace)' : ''} |`),
        '',
        ...(risks.length === 0 ? [] : [
            `Passing units at or above ${Math.round(TIMEOUT_MARGIN_RATIO * 100)}% of the `
                + `${formatDuration(summary.timeoutMs)} per-unit timeout. Split or speed these up before they fail:`,
            '',
            ...risks.map(result => `- \`${result.id}\` used ${formatBudgetShare(result.durationMs, summary.timeoutMs)} (${formatDuration(result.durationMs)})`),
            '',
        ]),
    ].join('\n');
}

function safeName(testFile) {
    return basename(testFile).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function signalProcessGroup(child, signal) {
    if (!child.pid) return;
    try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
    } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
    }
}

export function runTestProcess(command, args, options, onChild, timing = {}) {
    const terminationGraceMs = timing.terminationGraceMs ?? TERMINATION_GRACE_MS;
    const forcedExitWaitMs = timing.forcedExitWaitMs ?? FORCED_EXIT_WAIT_MS;
    return new Promise((resolveProcess) => {
        const child = spawn(command, args, {
            ...options,
            detached: process.platform !== 'win32',
        });
        onChild(child);
        let timedOut = false;
        let exitStatus = null;
        let exitSignal = null;
        let settled = false;
        let hardKillTimer = null;
        let forcedExitTimer = null;

        const finish = (error = null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutTimer);
            if (hardKillTimer) clearTimeout(hardKillTimer);
            if (forcedExitTimer) clearTimeout(forcedExitTimer);
            onChild(null);
            resolveProcess({ status: exitStatus, signal: exitSignal, timedOut, error });
        };
        const timeoutTimer = setTimeout(() => {
            timedOut = true;
            signalProcessGroup(child, 'SIGTERM');
            hardKillTimer = setTimeout(() => {
                signalProcessGroup(child, 'SIGKILL');
                forcedExitTimer = setTimeout(() => finish(), forcedExitWaitMs);
            }, terminationGraceMs);
        }, options.timeout);

        child.once('error', finish);
        child.once('exit', (status, signal) => {
            exitStatus = status;
            exitSignal = signal;
        });
        child.once('close', (status, signal) => {
            exitStatus = status;
            exitSignal = signal;
            finish();
        });
    });
}

export function shouldFlushRedis(setting) {
    return setting?.trim().toLowerCase() === 'flush';
}

async function connectRedisIsolation() {
    const setting = process.env.PROPR_TEST_REDIS_ISOLATION?.toLowerCase();
    if (!shouldFlushRedis(setting)) return null;
    // Loaded lazily so manifest listing and shard verification work in jobs
    // that only have a checkout and no installed dependencies.
    const { createClient } = await import('redis');
    const client = createClient({
        socket: {
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: Number(process.env.REDIS_PORT || 6379),
            connectTimeout: 5_000,
        },
    });
    client.on('error', error => console.error('Test Redis isolation error:', error.message));
    await client.connect();
    return client;
}

function failureReason(result, timeout) {
    return result.timedOut
        ? `timed out after ${timeout}ms; process group terminated`
        : result.signal
            ? `terminated by ${result.signal}`
            : result.error
                ? result.error.message
                : `exit ${result.status}`;
}

function resolveShard(cliShard, env) {
    const cliConfigured = cliShard.index !== undefined || cliShard.count !== undefined;
    const envConfigured = Boolean(env.PROPR_TEST_SHARD_INDEX || env.PROPR_TEST_SHARD_COUNT);
    if (cliConfigured && envConfigured) {
        throw new Error('Configure sharding with either --shard or PROPR_TEST_SHARD_INDEX/COUNT, not both');
    }
    return parseShardConfig(cliConfigured
        ? cliShard
        : { index: env.PROPR_TEST_SHARD_INDEX, count: env.PROPR_TEST_SHARD_COUNT });
}

export function verifyShardSummaryFiles(files, expectedCount, root = ROOT) {
    const summaries = files.map(file => JSON.parse(readFileSync(file, 'utf8')));
    const { allUnits } = planRun({ root });
    return verifyShardSummaries(summaries, allUnits, expectedCount);
}

export async function runSuite(argv = process.argv.slice(2), env = process.env) {
    const options = parseCliArguments(argv);
    if (options.verifyShardSummaries) {
        const expectedCount = parseShardConfig({ index: '1', count: env.PROPR_TEST_SHARD_COUNT })?.count;
        if (!expectedCount) throw new Error('PROPR_TEST_SHARD_COUNT is required to verify shard summaries');
        const verification = verifyShardSummaryFiles(options.verifyShardSummaries, expectedCount);
        if (!verification.ok) {
            console.error(`Shard coverage verification failed (${verification.errors.length} problems):`);
            for (const error of verification.errors) console.error(`- ${error}`);
            return 1;
        }
        console.log(`Verified ${verification.shards} shards ran all ${verification.units} discovered test units exactly once.`);
        return 0;
    }

    const plan = planRun({ requestedFiles: options.files, shard: resolveShard(options.shard, env) });
    if (options.list) {
        console.log(JSON.stringify(buildManifest(plan), null, 2));
        return 0;
    }

    const { units, shard } = plan;
    const timeout = parseTimeout(env.PROPR_TEST_TIMEOUT_MS);
    const tsx = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    const suiteDataDirectory = mkdtempSync(join(tmpdir(), 'propr-test-suite-'));
    const results = [];
    const startedAt = Date.now();
    let redisClient = null;
    let activeChild = null;
    let interruptedSignal = null;
    let interruptKillTimer = null;
    const handleInterrupt = (signal) => {
        if (interruptedSignal) return;
        interruptedSignal = signal;
        if (!activeChild) return;
        signalProcessGroup(activeChild, signal);
        interruptKillTimer = setTimeout(() => {
            if (activeChild) signalProcessGroup(activeChild, 'SIGKILL');
        }, TERMINATION_GRACE_MS);
    };
    const handleSigint = () => handleInterrupt('SIGINT');
    const handleSigterm = () => handleInterrupt('SIGTERM');
    process.once('SIGINT', handleSigint);
    process.once('SIGTERM', handleSigterm);

    if (shard) {
        console.log(`Running shard ${shard.index}/${shard.count}: ${units.length} of ${plan.allUnits.length} discovered test units.`);
    }

    try {
        redisClient = await connectRedisIsolation();
        for (const [index, unit] of units.entries()) {
            if (interruptedSignal) break;
            const testDataDirectory = join(suiteDataDirectory, `${String(index + 1).padStart(3, '0')}-${safeName(unit.id)}`);
            mkdirSync(testDataDirectory, { recursive: true });
            if (redisClient) await redisClient.flushDb();

            const label = unit.kind === 'workspace' ? `${unit.id} (workspace test script)` : unit.id;
            console.log(`\n[${index + 1}/${units.length}] ${label}`);
            const [command, args] = unit.kind === 'workspace'
                ? buildWorkspaceCommand(unit)
                : [tsx, buildTestArguments(unit.path)];

            const unitStartedAt = Date.now();
            const result = await runTestProcess(command, args, {
                cwd: ROOT,
                env: {
                    PROPR_DESKTOP_TEST_FSYNC: 'off',
                    ...env,
                    NODE_ENV: 'test',
                    DATA_DIR: testDataDirectory,
                },
                stdio: 'inherit',
                timeout,
            }, child => { activeChild = child; });
            const durationMs = Date.now() - unitStartedAt;

            if (interruptedSignal) break;
            const failed = result.status !== 0 || result.timedOut || result.error;
            results.push({
                kind: unit.kind,
                id: unit.id,
                status: failed ? 'failed' : 'passed',
                durationMs,
                ...(failed ? { reason: failureReason(result, timeout) } : {}),
            });
            console.log(`[${index + 1}/${units.length}] ${failed ? 'FAILED' : 'passed'} ${label} in ${formatDuration(durationMs)}`);
        }
    } finally {
        process.removeListener('SIGINT', handleSigint);
        process.removeListener('SIGTERM', handleSigterm);
        if (interruptKillTimer) clearTimeout(interruptKillTimer);
        if (redisClient) await redisClient.quit();
        rmSync(suiteDataDirectory, { recursive: true, force: true });
    }

    const failures = results.filter(result => result.status === 'failed');
    const summary = {
        schemaVersion: 1,
        shard,
        runAttempt: Number(env.GITHUB_RUN_ATTEMPT) || 1,
        timeoutMs: timeout,
        totalUnits: plan.allUnits.length,
        assignedUnits: units.length,
        durationMs: Date.now() - startedAt,
        passed: results.length - failures.length,
        failed: failures.length,
        interrupted: interruptedSignal,
        results,
    };
    if (env.PROPR_TEST_SUMMARY_FILE) {
        writeFileSync(env.PROPR_TEST_SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`);
    }

    if (interruptedSignal) return interruptedSignal === 'SIGINT' ? 130 : 143;

    const timingReport = formatTimingReport(summary);
    console.log(`\n${timingReport}`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${timingReport}\n`);

    // A unit creeping towards the per-unit timeout is reported while the run
    // is still green, so it can be split before it starts failing.
    for (const risk of selectTimeoutRisks(summary)) {
        console.warn(formatTimeoutRiskWarning(risk, summary.timeoutMs, env));
    }

    const durationSeconds = (summary.durationMs / 1000).toFixed(1);
    const scope = shard ? ` in shard ${shard.index}/${shard.count}` : '';
    if (failures.length > 0) {
        console.error(`\n${failures.length}/${units.length} test runs failed${scope} after ${durationSeconds}s:`);
        for (const failure of failures) {
            console.error(`- ${failure.id}${failure.kind === 'workspace' ? ' (workspace test script)' : ''}: ${failure.reason}`);
        }
        return 1;
    }

    const fileCount = results.filter(result => result.kind === 'file').length;
    const workspaceCount = results.length - fileCount;
    console.log(`\nAll ${fileCount} non-live test files and ${workspaceCount} native workspace suite parts passed${scope} in ${durationSeconds}s.`);
    return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runSuite()
        .then(exitCode => { process.exitCode = exitCode; })
        .catch(error => {
            console.error(error instanceof Error ? error.message : error);
            process.exitCode = 1;
        });
}
