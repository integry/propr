import type { UltrafixDeps } from '@propr/core';
import { loadUltrafixRatingGoal, loadUltrafixMaxCycles, loadUltrafixPauseSeconds, loadPrReviewModel } from '@propr/core';
import { startLoop, clearStateIfGenerationCurrent, clearDeferredContinuation } from './ultrafixOrchestrationService.js';
import { getPendingReviewState } from './reviewCommentGatherer.js';
import { withUltrafixTransitionLease } from './ultrafixTransitionLease.js';

export function createUltrafixDeps(): UltrafixDeps {
    return {
        loadUltrafixRatingGoal,
        loadUltrafixMaxCycles,
        loadUltrafixPauseSeconds,
        loadPrReviewModel,
        startLoop,
        clearStateIfGenerationCurrent,
        clearDeferredContinuation,
        withTransitionLease: withUltrafixTransitionLease,
        getPendingReviewState,
    };
}
