/**
 * Shared opening of every "Ultrafix stopped before reaching its goal" comment:
 * the requested goal, the score of the loop's last review, and the cycle it
 * stopped in (numbered as on the PR status line, see ultrafixStepCycle).
 */
export function buildUltrafixStopNoticeHeader(input: {
    goal?: number;
    lastScore?: number | null;
    cycle?: number;
    maxCycles?: number;
}): string {
    const goal = input.goal !== undefined ? `Requested goal: ${input.goal}/10. ` : '';
    const score = typeof input.lastScore === 'number' ? `${input.lastScore}/10` : 'unknown';
    const cycle = input.cycle !== undefined
        ? `Stopped in cycle ${input.cycle}${input.maxCycles ? ` of ${input.maxCycles}` : ''}. `
        : '';
    return `⚠️ **Ultrafix stopped before reaching its goal.** ${goal}Last score: ${score}. ${cycle}`;
}
