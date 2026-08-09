import type { UltrafixDeps } from '@propr/core';
import { loadUltrafixRatingGoal, loadUltrafixMaxCycles, loadUltrafixPauseSeconds, loadPrReviewModel } from '@propr/core';
import {
    clearUltrafixStateIfCurrent,
    hasUltrafixAutomaticWork,
    invalidateUltrafixAutomaticWork,
    invalidateUltrafixAutomaticWorkForComment,
    startLoop,
    withUltrafixLabelTransition,
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
        withLabelTransition: withUltrafixLabelTransition,
        invalidateAutomaticWork: invalidateUltrafixAutomaticWorkForComment,
        getPendingReviewState,
    };
}
