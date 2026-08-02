#!/usr/bin/env node

import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_TIMEOUT_MS = 180_000;
const TEST_FILE_PATTERN = /\.test\.(?:ts|mjs|js)$/;
const EXCLUDED_TESTS = new Set(['e2e.test.ts']);
const TEST_ROOTS = [
    'test',
    'packages/api/test',
    'packages/cli/src',
    'packages/core/test',
];

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

export function requiresModuleMocks(contents) {
    return contents.includes('mock.module(');
}

export function buildTestArguments(testFile, usesModuleMocks) {
    return [
        ...(usesModuleMocks ? ['--experimental-test-module-mocks'] : []),
        '--test',
        '--test-force-exit',
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

function discoverTestFiles(requestedFiles) {
    if (requestedFiles.length > 0) {
        return selectTestFiles(requestedFiles.map(file => resolve(ROOT, file)));
    }

    const discovered = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile()) discovered.push(path);
        }
    };
    for (const root of TEST_ROOTS) visit(join(ROOT, root));
    return selectTestFiles(discovered);
}

function safeName(testFile) {
    return basename(testFile).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function runSuite(requestedFiles = process.argv.slice(2)) {
    const testFiles = discoverTestFiles(requestedFiles);
    if (testFiles.length === 0) {
        throw new Error('No non-live test files matched');
    }

    const timeout = parseTimeout(process.env.PROPR_TEST_TIMEOUT_MS);
    const tsx = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    const suiteDataDirectory = mkdtempSync(join(tmpdir(), 'propr-test-suite-'));
    const failures = [];
    const startedAt = Date.now();

    try {
        for (const [index, testFile] of testFiles.entries()) {
            const relativeFile = testFile.startsWith(`${ROOT}/`) ? testFile.slice(ROOT.length + 1) : testFile;
            const testDataDirectory = join(suiteDataDirectory, `${String(index + 1).padStart(3, '0')}-${safeName(testFile)}`);
            mkdirSync(testDataDirectory, { recursive: true });

            const usesModuleMocks = requiresModuleMocks(readFileSync(testFile, 'utf8'));
            const args = buildTestArguments(testFile, usesModuleMocks);
            console.log(`\n[${index + 1}/${testFiles.length}] ${relativeFile}${usesModuleMocks ? ' (module mocks)' : ''}`);

            const result = spawnSync(tsx, args, {
                cwd: ROOT,
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    DATA_DIR: testDataDirectory,
                },
                stdio: 'inherit',
                timeout,
                killSignal: 'SIGTERM',
            });

            if (result.status !== 0) {
                failures.push({
                    file: relativeFile,
                    status: result.status,
                    signal: result.signal,
                    timedOut: result.error?.code === 'ETIMEDOUT',
                });
            }
        }
    } finally {
        rmSync(suiteDataDirectory, { recursive: true, force: true });
    }

    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (failures.length > 0) {
        console.error(`\n${failures.length}/${testFiles.length} test files failed after ${durationSeconds}s:`);
        for (const failure of failures) {
            const reason = failure.timedOut
                ? `timed out after ${timeout}ms`
                : failure.signal
                    ? `terminated by ${failure.signal}`
                    : `exit ${failure.status}`;
            console.error(`- ${failure.file}: ${reason}`);
        }
        return 1;
    }

    console.log(`\nAll ${testFiles.length} non-live test files passed in ${durationSeconds}s.`);
    return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = runSuite();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
