import type { UltrafixDeps } from '@propr/core';
import { loadUltrafixRatingGoal, loadUltrafixMaxCycles, loadUltrafixPauseSeconds, loadPrReviewModel } from '@propr/core';
import {
    clearUltrafixStateIfCurrent,
    hasUltrafixAutomaticWork,
    invalidateUltrafixAutomaticWork,
    invalidateUltrafixAutomaticWorkForComment,
    startLoop,
} from './ultrafixOrchestrationService.js';
import { getPendingReviewState } from './reviewCommentGatherer.js';
import { installUltrafixCoreJournal } from './ultrafixJournal.js';

/**
 * Ultrafix dependencies for a process that runs loops (daemon, worker, API server).
 * Such a process owns the database, so loop start and end are journaled there.
 */
export function createUltrafixDeps(): UltrafixDeps {
    installUltrafixCoreJournal();
    return {
        loadUltrafixRatingGoal,
        loadUltrafixMaxCycles,
        loadUltrafixPauseSeconds,
        loadPrReviewModel,
        startLoop,
        clearStateIfCurrent: clearUltrafixStateIfCurrent,
        hasAutomaticWork: hasUltrafixAutomaticWork,
        reserveAutomaticWork: invalidateUltrafixAutomaticWork,
        invalidateAutomaticWork: invalidateUltrafixAutomaticWorkForComment,
        getPendingReviewState,
    };
}
