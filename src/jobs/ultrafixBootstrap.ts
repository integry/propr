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

export function createUltrafixDeps(): UltrafixDeps {
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
