import { loadUltrafixMaxCycles, loadUltrafixRatingGoal } from '@propr/core';
import { z } from 'zod';

/** Tools whose receipt follows a posted `/ultrafix` command through the review/fix loop. */
export const ULTRAFIX_COMMAND_TOOLS: readonly string[] = ['run_ultrafix', 'start_ultrafix'];

export const isUltrafixCommandTool = (tool: string): boolean => ULTRAFIX_COMMAND_TOOLS.includes(tool);

/**
 * No literal default: an omitted goal resolves at call time from the instance's
 * `ultrafix_rating_goal`, so the MCP surface never disagrees with the setting.
 */
export const ultrafixGoalSchema = z.number().int().min(1).max(10).optional()
  .describe('Review score (1-10) the loop stops at. Defaults to the instance ultrafix rating goal (ultrafix_rating_goal).');

/** The goal a caller asked for, or the instance rating goal when they omitted it. */
export async function resolveUltrafixGoal(goal: number | undefined): Promise<number> {
  return goal ?? await loadUltrafixRatingGoal();
}

/** The cycle bound a caller asked for, or the instance `ultrafix_max_cycles` when they omitted it. */
export async function resolveUltrafixMaxCycles(maxCycles: number | undefined): Promise<number> {
  return maxCycles ?? await loadUltrafixMaxCycles();
}
