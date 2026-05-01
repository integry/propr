/**
 * Ultrafix initialization service.
 *
 * Centralizes the cross-package imports for ultrafix bootstrap and
 * loop continuation so server.ts doesn't depend on monorepo-internal
 * file paths directly.
 */

import {
    setUltrafixDeps,
    setUltrafixCheckRunHook,
    generateCorrelationId,
    logger,
} from '@propr/core';
import type { Redis } from 'ioredis';
import * as configManager from '@propr/core';

async function importWithTsFallback(jsPath: string) {
    try { return await import(jsPath); } catch { return await import(jsPath.replace(/\.js$/, '.ts')); }
}

// Paths are relative to this file's location in packages/api/services/
const BOOTSTRAP_PATH = '../../../src/jobs/ultrafixBootstrap.js';
const CONTINUATION_PATH = '../../../src/jobs/ultrafixLoopContinuation.js';

export async function initializeUltrafix(ioRedisClient: Redis): Promise<void> {
    const { createUltrafixDeps } = await importWithTsFallback(BOOTSTRAP_PATH);
    setUltrafixDeps(createUltrafixDeps());
    console.log('[ultrafix] Ultrafix dependencies initialized');

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
    console.log('[ultrafix] Check run hook initialized');
}
