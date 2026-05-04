/**
 * Ultrafix initialization service.
 *
 * Centralizes bootstrap imports and resolves them from either the
 * repo source tree (tsx/dev) or the root dist output (compiled app).
 */

import { access } from 'fs/promises';
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

async function resolveJobModulePath(filename: string): Promise<string> {
    const candidates = [
        path.resolve(__dirname, '../../../src/jobs', filename),
        path.resolve(process.cwd(), 'dist/src/jobs', filename),
        path.resolve(process.cwd(), 'src/jobs', filename),
    ];

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
