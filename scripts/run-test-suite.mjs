#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from 'redis';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_TIMEOUT_MS = 180_000;
const TERMINATION_GRACE_MS = 2_000;
const FORCED_EXIT_WAIT_MS = 2_000;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const EXCLUDED_TESTS = new Set(['e2e.test.ts']);
const IGNORED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules']);

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

export async function runSuite(requestedFiles = process.argv.slice(2)) {
    const testFiles = discoverTestFiles(requestedFiles);
    const nativeWorkspaces = requestedFiles.length === 0 ? discoverNativeWorkspaceTests() : [];
    if (testFiles.length === 0 && nativeWorkspaces.length === 0) {
        throw new Error('No non-live test files matched');
    }

    const timeout = parseTimeout(process.env.PROPR_TEST_TIMEOUT_MS);
    const tsx = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    const suiteDataDirectory = mkdtempSync(join(tmpdir(), 'propr-test-suite-'));
    const failures = [];
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

    try {
        redisClient = await connectRedisIsolation();
        const totalRuns = testFiles.length + nativeWorkspaces.length;
        for (const [index, testFile] of testFiles.entries()) {
            if (interruptedSignal) break;
            const relativeFile = relative(ROOT, testFile).replaceAll('\\', '/');
            const testDataDirectory = join(suiteDataDirectory, `${String(index + 1).padStart(3, '0')}-${safeName(testFile)}`);
            mkdirSync(testDataDirectory, { recursive: true });
            if (redisClient) await redisClient.flushDb();

            const args = buildTestArguments(testFile);
            console.log(`\n[${index + 1}/${totalRuns}] ${relativeFile}`);

            const result = await runTestProcess(tsx, args, {
                cwd: ROOT,
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    DATA_DIR: testDataDirectory,
                },
                stdio: 'inherit',
                timeout,
            }, child => { activeChild = child; });

            if (interruptedSignal) break;
            if (result.status !== 0 || result.timedOut || result.error) {
                failures.push({ file: relativeFile, ...result });
            }
        }
        for (const [nativeIndex, workspace] of nativeWorkspaces.entries()) {
            if (interruptedSignal) break;
            const index = testFiles.length + nativeIndex;
            const testDataDirectory = join(suiteDataDirectory, `${String(index + 1).padStart(3, '0')}-${safeName(workspace)}`);
            mkdirSync(testDataDirectory, { recursive: true });
            if (redisClient) await redisClient.flushDb();
            console.log(`\n[${index + 1}/${totalRuns}] ${workspace} (workspace test script)`);

            const result = await runTestProcess(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
                'test',
                `--workspace=${workspace}`,
            ], {
                cwd: ROOT,
                env: { ...process.env, NODE_ENV: 'test', DATA_DIR: testDataDirectory },
                stdio: 'inherit',
                timeout,
            }, child => { activeChild = child; });
            if (interruptedSignal) break;
            if (result.status !== 0 || result.timedOut || result.error) {
                failures.push({ file: `${workspace} (workspace test script)`, ...result });
            }
        }
    } finally {
        process.removeListener('SIGINT', handleSigint);
        process.removeListener('SIGTERM', handleSigterm);
        if (interruptKillTimer) clearTimeout(interruptKillTimer);
        if (redisClient) await redisClient.quit();
        rmSync(suiteDataDirectory, { recursive: true, force: true });
    }

    if (interruptedSignal) return interruptedSignal === 'SIGINT' ? 130 : 143;

    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (failures.length > 0) {
        console.error(`\n${failures.length}/${testFiles.length + nativeWorkspaces.length} test runs failed after ${durationSeconds}s:`);
        for (const failure of failures) {
            const reason = failure.timedOut
                ? `timed out after ${timeout}ms; process group terminated`
                : failure.signal
                    ? `terminated by ${failure.signal}`
                    : failure.error
                        ? failure.error.message
                        : `exit ${failure.status}`;
            console.error(`- ${failure.file}: ${reason}`);
        }
        return 1;
    }

    console.log(`\nAll ${testFiles.length} non-live test files and ${nativeWorkspaces.length} native workspace suites passed in ${durationSeconds}s.`);
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
