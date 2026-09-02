import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { GoalContainerLayout, GoalContainerRetentionPolicy } from './goalContainerLayout.js';
import { GOAL_SCOPE_PATTERN } from './goalContainerLayout.js';

export async function cleanTerminalGoalSession(
    options: {
        baseDirectory: string; retention: GoalContainerRetentionPolicy; layout: GoalContainerLayout;
        terminalAt: Date; outcome: 'succeeded' | 'cancelled' | 'failed'; currentTime: Date;
    },
): Promise<boolean> {
    const { baseDirectory, retention, layout, terminalAt, outcome, currentTime } = options;
    const duration = outcome === 'succeeded' ? retention.succeededMs
        : outcome === 'cancelled' ? retention.cancelledMs : retention.failedMs;
    if (currentTime < new Date(terminalAt.getTime() + duration)) return false;
    const realGoals = await realpath(path.join(await realpath(baseDirectory), 'goals')).catch(() => null);
    if (!realGoals) return false;
    const lexicalRoot = path.resolve(layout.sessionRoot);
    if (path.dirname(lexicalRoot) !== realGoals || !GOAL_SCOPE_PATTERN.test(path.basename(lexicalRoot))) {
        throw new Error('Refusing to clean a path outside the goal container resource directory');
    }
    let resolvedRoot: string;
    try { resolvedRoot = await realpath(lexicalRoot); }
    catch { return false; }
    if (resolvedRoot !== lexicalRoot) throw new Error('Refusing to clean a symlinked goal session directory');
    await rm(resolvedRoot, { recursive: true, force: true });
    return true;
}
