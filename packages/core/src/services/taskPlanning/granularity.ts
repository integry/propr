/**
 * Granularity enforcement for generated plans.
 */

import type { Plan, PlanItem } from '../../claude/prompts/plannerPrompts.js';
import type { Granularity, MinimalLogger } from '../planning/index.js';
import type { EnforceGranularityResult } from './types.js';

/**
 * Enforce granularity constraints on the generated plan.
 * - For 'single': If multiple tasks are returned, merge them into one comprehensive task
 * - For 'balanced' and 'granular': No enforcement needed, LLM output is used as-is
 */
export function enforceGranularity(plan: Plan, granularity: Granularity, correlatedLogger: MinimalLogger): EnforceGranularityResult {
  const originalTaskCount = plan.length;

  if (granularity !== 'single') {
    // For balanced and granular, no enforcement needed
    return {
      plan,
      metadata: {
        enforced: false,
        granularity,
        originalTaskCount,
        finalTaskCount: plan.length
      }
    };
  }

  // For single granularity, enforce exactly one task
  if (plan.length === 1) {
    correlatedLogger.info({ taskCount: 1 }, 'Single granularity: Plan already has exactly one task');
    return {
      plan,
      metadata: {
        enforced: false,
        granularity,
        originalTaskCount: 1,
        finalTaskCount: 1
      }
    };
  }

  // Multiple tasks returned for single granularity - merge them
  correlatedLogger.warn(
    { taskCount: plan.length, granularity },
    'Single granularity selected but LLM returned multiple tasks - merging into one'
  );

  // Merge all tasks into a single comprehensive task
  const mergedTask: PlanItem = {
    title: generateMergedTitle(plan),
    body: mergeBodies(plan),
    implementation: mergeImplementations(plan)
  };

  correlatedLogger.info(
    { originalTaskCount: plan.length, mergedTitle: mergedTask.title },
    'Successfully merged tasks into single comprehensive task'
  );

  return {
    plan: [mergedTask],
    metadata: {
      enforced: true,
      granularity,
      originalTaskCount,
      finalTaskCount: 1,
      message: `${originalTaskCount} tasks merged into 1 per your Single Task setting`
    }
  };
}

/**
 * Generate a merged title that reflects all task titles in the plan.
 * Exported for testability.
 */
export function generateMergedTitle(tasks: PlanItem[]): string {
  if (tasks.length === 0) return 'Comprehensive Implementation';
  if (tasks.length === 1) return tasks[0].title;
  if (tasks.length === 2) return `${tasks[0].title} and ${tasks[1].title}`;
  return `${tasks[0].title}, ${tasks[1].title}, and ${tasks.length - 2} more`;
}

/**
 * Merge multiple task bodies into a single comprehensive body
 */
function mergeBodies(tasks: PlanItem[]): string {
  if (tasks.length === 0) return '';
  if (tasks.length === 1) return tasks[0].body;

  const sections: string[] = [];

  // Add context section
  sections.push('## Context\n\nThis comprehensive task combines multiple related changes into a single implementation.\n');

  // Add requirements from all tasks
  sections.push('## Requirements\n');
  tasks.forEach((task, index) => {
    sections.push(`### Part ${index + 1}: ${task.title}\n\n${task.body}\n`);
  });

  // Add acceptance criteria
  sections.push('## Acceptance Criteria\n\n- [ ] All changes from the sections above are implemented correctly\n- [ ] Code follows existing patterns and conventions\n- [ ] All tests pass\n');

  return sections.join('\n');
}

/**
 * Merge multiple task implementations into a single comprehensive implementation
 */
function mergeImplementations(tasks: PlanItem[]): string {
  if (tasks.length === 0) return '';
  if (tasks.length === 1) return tasks[0].implementation;

  const implementations: string[] = [];

  tasks.forEach((task, index) => {
    if (task.implementation && task.implementation.trim()) {
      implementations.push(`// ============================================`);
      implementations.push(`// Part ${index + 1}: ${task.title}`);
      implementations.push(`// ============================================\n`);
      implementations.push(task.implementation);
      implementations.push('');
    }
  });

  return implementations.join('\n');
}
