import type { UltrafixDeps } from '@propr/core';
import { loadUltrafixRatingGoal, loadUltrafixMaxCycles, loadUltrafixPauseSeconds, loadPrReviewModel } from '@propr/core';
import {
    abortManualUltrafixTakeover,
    beginManualUltrafixTakeover,
    clearStateIfGenerationCurrent,
    completeManualUltrafixTakeover,
    startFreshUltrafixTransition,
    startLoop,
} from './ultrafixOrchestrationService.js';
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
        beginManualTakeover: beginManualUltrafixTakeover,
        abortManualTakeover: abortManualUltrafixTakeover,
        completeManualTakeover: completeManualUltrafixTakeover,
        startFreshTransition: startFreshUltrafixTransition,
        withTransitionLease: withUltrafixTransitionLease,
        getPendingReviewState,
    };
}
