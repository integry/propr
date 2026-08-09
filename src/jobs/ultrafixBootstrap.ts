import type { UltrafixDeps } from '@propr/core';
import { loadUltrafixRatingGoal, loadUltrafixMaxCycles, loadUltrafixPauseSeconds, loadPrReviewModel } from '@propr/core';
import {
    abortManualUltrafixTakeover,
    abortFreshUltrafixTransition,
    beginManualUltrafixTakeover,
    commitFreshUltrafixLoop,
    completeManualUltrafixTakeover,
    reserveFreshUltrafixTransition,
} from './ultrafixOrchestrationService.js';
import { getPendingReviewState } from './reviewCommentGatherer.js';
import { withUltrafixTransitionLease } from './ultrafixTransitionLease.js';

export function createUltrafixDeps(): UltrafixDeps {
    return {
        loadUltrafixRatingGoal,
        loadUltrafixMaxCycles,
        loadUltrafixPauseSeconds,
        loadPrReviewModel,
        beginManualTakeover: beginManualUltrafixTakeover,
        abortManualTakeover: abortManualUltrafixTakeover,
        completeManualTakeover: completeManualUltrafixTakeover,
        reserveFreshTransition: reserveFreshUltrafixTransition,
        commitFreshLoop: commitFreshUltrafixLoop,
        abortFreshTransition: abortFreshUltrafixTransition,
        withTransitionLease: withUltrafixTransitionLease,
        getPendingReviewState,
    };
}
