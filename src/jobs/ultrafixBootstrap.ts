import type { UltrafixDeps } from '@propr/core';
import { loadUltrafixRatingGoal, loadUltrafixMaxCycles, loadUltrafixPauseSeconds, loadPrReviewModel } from '@propr/core';
import {
    clearState,
    getUltrafixAutomaticWorkEpoch,
    hasUltrafixAutomaticWork,
    invalidateUltrafixAutomaticWork,
    startLoop,
} from './ultrafixOrchestrationService.js';
import { getPendingReviewState } from './reviewCommentGatherer.js';

export function createUltrafixDeps(): UltrafixDeps {
    return {
        loadUltrafixRatingGoal,
        loadUltrafixMaxCycles,
        loadUltrafixPauseSeconds,
        loadPrReviewModel,
        startLoop,
        clearState,
        hasAutomaticWork: hasUltrafixAutomaticWork,
        getAutomaticWorkEpoch: getUltrafixAutomaticWorkEpoch,
        invalidateAutomaticWork: invalidateUltrafixAutomaticWork,
        getPendingReviewState,
    };
}
