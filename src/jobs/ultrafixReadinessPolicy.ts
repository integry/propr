import type { UltrafixAction, UltrafixCheckStatus } from './ultrafixOrchestrationService.js';

/** Interpret GitHub check/status state for a CI-gated transition. */
export function areChecksReadyForUltrafix(status: UltrafixCheckStatus): boolean {
    return status.allPassing;
}

/**
 * CI must be settled and passing before reviewing a completed fix. A fix may
 * start with red CI because repairing that failure can be the purpose of the
 * transition.
 */
export function requiresPassingChecks(nextAction: UltrafixAction): boolean {
    return nextAction === 'review';
}
