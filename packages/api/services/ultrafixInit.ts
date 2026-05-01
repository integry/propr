/**
 * Ultrafix initialization service.
 *
 * Centralizes the cross-package imports for ultrafix bootstrap and
 * loop continuation so server.ts doesn't depend on monorepo-internal
 * file paths directly.
 */

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

async function importWithTsFallback(absolutePath: string) {
    try { return await import(absolutePath); } catch { return await import(absolutePath.replace(/\.js$/, '.ts')); }
}

const BOOTSTRAP_PATH = path.resolve(__dirname, '../../../src/jobs/ultrafixBootstrap.js');
const CONTINUATION_PATH = path.resolve(__dirname, '../../../src/jobs/ultrafixLoopContinuation.js');

export async function initializeUltrafix(ioRedisClient: Redis): Promise<void> {
    try {
        const { createUltrafixDeps } = await importWithTsFallback(BOOTSTRAP_PATH);
        setUltrafixDeps(createUltrafixDeps());
        logger.info({ bootstrapPath: BOOTSTRAP_PATH }, '[ultrafix] Ultrafix dependencies initialized');

        const contMod = await importWithTsFallback(CONTINUATION_PATH);
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
        logger.error({ error: (error as Error).message, bootstrapPath: BOOTSTRAP_PATH, continuationPath: CONTINUATION_PATH },
            '[ultrafix] Failed to initialize — server will continue without ultrafix support');
    }
}
