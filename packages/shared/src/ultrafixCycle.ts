/**
 * Ultrafix cycle numbering, shared by the loop's stop notice and the PR status
 * line so the two never disagree.
 *
 * Cycle N holds the Nth review step and the Nth fix step, whichever of them
 * runs first. The loop's cycle is the cycle of the step it is on: the step that
 * runs or is awaited next while the loop is active, and the step it ended on
 * once it has stopped.
 */

export interface UltrafixCycleCounts {
    /** Completed review steps. */
    reviewCount: number;
    /** Completed fix steps. */
    fixCount: number;
    maxCycles: number;
}

/**
 * Completed review and fix steps of a loop state. State written before the
 * explicit per-action counts derives them from its cycle count and last action.
 */
export function getActionCounts(state: {
    reviewCount?: number; fixCount?: number; cycleCount: number; lastAction: 'review' | 'fix' | null;
}): { reviewCount: number; fixCount: number } {
    if (typeof state.reviewCount === 'number' && typeof state.fixCount === 'number') {
        return { reviewCount: state.reviewCount, fixCount: state.fixCount };
    }
    if (state.lastAction === 'review') return { reviewCount: state.cycleCount + 1, fixCount: state.cycleCount };
    if (state.lastAction === 'fix') return { reviewCount: state.cycleCount, fixCount: state.cycleCount };
    return { reviewCount: 0, fixCount: 0 };
}

function capCycle(cycle: number, maxCycles: number): number {
    return Math.max(1, Math.min(cycle, Math.max(maxCycles, 1)));
}

/** Cycle of one step: a completed step counts itself, a step not yet completed is the next of its kind. */
export function ultrafixStepCycle(
    counts: UltrafixCycleCounts,
    step: { action: 'review' | 'fix'; completed: boolean },
): number {
    const done = step.action === 'review' ? counts.reviewCount : counts.fixCount;
    return capCycle(step.completed ? done : done + 1, counts.maxCycles);
}

/**
 * Cycle of the step an active loop runs or awaits next. That step is the other
 * kind than the last completed one, so it always belongs to the cycle after the
 * fully completed ones (`completedCycles`: both its review and its fix done).
 */
export function ultrafixActiveCycle(completedCycles: number, maxCycles: number): number {
    return capCycle(completedCycles + 1, maxCycles);
}
