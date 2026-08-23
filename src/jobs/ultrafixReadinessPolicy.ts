import type { UltrafixAction } from './ultrafixOrchestrationService.js';

/**
 * A fix may need to repair failing CI. Reviews inspect the result of a fix, so
 * they must wait for CI to settle and pass before running.
 */
export function requiresPassingChecks(nextAction: UltrafixAction): boolean {
    return nextAction === 'review';
}
