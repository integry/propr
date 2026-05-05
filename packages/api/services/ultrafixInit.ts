/**
 * Ultrafix initialization service.
 *
 * Centralizes bootstrap imports and resolves them from either the
 * repo source tree (tsx/dev) or the root dist output (compiled app).
 */

import { access, readdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import {
    setUltrafixDeps,
    setUltrafixCheckRunHook,
    generateCorrelationId,
    logger,
} from '@propr/core';
import type { Redis } from 'ioredis';
import * as configManager from '@propr/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function pathExists(candidatePath: string): Promise<boolean> {
    try {
        await access(candidatePath);
        return true;
    } catch {
        return false;
    }
}

function collectAncestorDirectories(startDir: string): string[] {
    const directories: string[] = [];
    let currentDir = path.resolve(startDir);

    while (true) {
        directories.push(currentDir);
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            break;
        }
        currentDir = parentDir;
    }

    return directories;
}

async function collectPackageDirectories(rootDir: string): Promise<string[]> {
    const packageParents = [
        path.join(rootDir, 'packages'),
        path.join(rootDir, 'dist/packages'),
    ];
    const packageDirs: string[] = [];

    for (const packageParent of packageParents) {
        try {
            const entries = await readdir(packageParent, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    packageDirs.push(path.join(packageParent, entry.name));
                }
            }
        } catch {
            // Ignore missing package roots while continuing other candidate locations.
        }
    }

    return packageDirs;
}

export async function resolveJobModulePath(filename: string): Promise<string> {
    const searchRoots = Array.from(new Set([
        ...collectAncestorDirectories(__dirname),
        ...collectAncestorDirectories(process.cwd()),
    ]));
    const packageRoots = (await Promise.all(searchRoots.map(collectPackageDirectories))).flat();
    const baseCandidates = [
        ...searchRoots.flatMap((rootDir) => ([
            path.join(rootDir, 'src/jobs', filename),
            path.join(rootDir, 'dist/src/jobs', filename),
        ])),
        ...packageRoots.flatMap((packageDir) => ([
            path.join(packageDir, 'src/jobs', filename),
            path.join(packageDir, 'dist/src/jobs', filename),
        ])),
    ];
    const candidates = baseCandidates.flatMap((candidate) => {
        const tsCandidate = candidate.replace(/\.js$/, '.ts');
        return tsCandidate === candidate ? [candidate] : [candidate, tsCandidate];
    });

    for (const candidate of candidates) {
        if (await pathExists(candidate)) {
            return candidate;
        }
    }

    throw new Error(`Could not resolve ultrafix job module: ${filename}`);
}

async function importWithTsFallback(modulePath: string) {
    try {
        return await import(modulePath);
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
            return await import(modulePath.replace(/\.js$/, '.ts'));
        }
        throw err;
    }
}

export async function initializeUltrafix(ioRedisClient: Redis): Promise<void> {
    try {
        const bootstrapPath = await resolveJobModulePath('ultrafixBootstrap.js');
        const continuationPath = await resolveJobModulePath('ultrafixLoopContinuation.js');

        const { createUltrafixDeps } = await importWithTsFallback(bootstrapPath);
        setUltrafixDeps(createUltrafixDeps());
        logger.info({ bootstrapPath }, '[ultrafix] Ultrafix dependencies initialized');

        const contMod = await importWithTsFallback(continuationPath);
        contMod.setCheckRunDeps({
            areAllChecksPassing: configManager.areAllChecksPassing,
            getCurrentPRHead: configManager.getCurrentPRHead,
            getCheckRunsStatus: configManager.getCheckRunsStatus,
        });

        setUltrafixCheckRunHook(async (owner: string, repo: string, prNumber: number, headSha: string) => {
            const log = logger.withCorrelation(generateCorrelationId());
            log.debug({ owner, repo, prNumber, headSha }, '[ultrafix] check_run hook triggered');
            const result = await contMod.resumeDeferredContinuation({ owner, repo, pr: prNumber }, ioRedisClient, log);
            if (result.continued) {
                log.info({ owner, repo, prNumber, result }, '[ultrafix] deferred continuation resumed');
            } else {
                log.debug({ owner, repo, prNumber, reason: result.reason }, '[ultrafix] no deferred continuation to resume');
            }
        });
        logger.info('[ultrafix] Check run hook initialized');
    } catch (error) {
        logger.error({ error: (error as Error).message },
            '[ultrafix] Failed to initialize — server will continue without ultrafix support');
    }
}
