export interface PlannerUltrafixSettings {
    runUltrafix: boolean;
    goal: number | null;
    maxCycles: number | null;
}

export interface ImplementationPrUltrafixTrigger {
    goal: number | null;
    maxCycles: number | null;
}

/**
 * Resolve the single Ultrafix bootstrap, if any, for an implementation PR.
 *
 * A source-issue label is an independent opt-in, but Planner settings retain
 * ownership of their configured overrides when both inputs are present.
 */
export function resolveImplementationPrUltrafixTrigger(
    sourceIssueLabels: ReadonlyArray<{ name: string }>,
    plannerSettings: PlannerUltrafixSettings,
): ImplementationPrUltrafixTrigger | null {
    const hasSourceIssueLabel = sourceIssueLabels.some((label) => label.name === 'ultrafix');
    if (!hasSourceIssueLabel && !plannerSettings.runUltrafix) return null;

    return {
        goal: plannerSettings.runUltrafix ? plannerSettings.goal : null,
        maxCycles: plannerSettings.runUltrafix ? plannerSettings.maxCycles : null,
    };
}
