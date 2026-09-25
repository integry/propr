/**
 * A work title split into its type and what the work is about.
 *
 * Run titles are written for GitHub, not for a feed: `Fix PR #2494: [Epic] MCP
 * operator surface`, `Followup: [870 by Claude Opus 4.6] Update checkout`. The
 * workflow verb, the entity number and the model that did the work are all
 * prefixes the eye has to read past on every row — and the number is already
 * on the row as a chip. So the verb becomes a badge in front of the title,
 * and the number and the model tag are dropped from it.
 */

export interface WorkTitle {
  /** Short task-type label for the badge, or null when nothing is known. */
  type: string | null;
  /** The title with its type prefix, entity number and model tag removed. */
  title: string | null;
}

/** Backend PR task titles: `Fix PR #2393: Add retries`. */
const PR_WORKFLOW_PREFIX = /^(Follow-?up|Fix|Review|Ultrafix|Merge)\s+PR\s+#\d+\s*:?\s*/i;

/** Other prefixes the backend writes into a run title, with the type each one names. */
const TITLE_PREFIXES: ReadonlyArray<[RegExp, string]> = [
  [/^New Issue:\s*/i, 'Implement'],
  [/^Follow-?up:\s*/i, 'Follow-up'],
  [/^Auto-followup for PR #\d+\s*:?\s*/i, 'Follow-up'],
  [/^Continue\s+#\d+\s*:\s*/i, 'Continue'],
];

/**
 * `[870 by Claude Opus]`, `[Fix by Claude Opus 4.6]`, `[Goal by GPT-5]` at the start of a title.
 * Only an issue number or a workflow name may come before `by`, so an ordinary
 * bracketed title such as `[Search by filename]` is left alone.
 */
const MODEL_TAGS = /^(?:\[(?:\d+|Goal|Fix|Review|Follow-?up|Ultrafix|Merge)\s+by\s+[^\]]+\]\s*)+/i;

/** Labels for the recorded task type, used when the title carries no verb. */
const TASK_TYPE_LABELS: Record<string, string> = {
  issue: 'Implement',
  'pr-comment': 'PR comment',
  pr_comment: 'PR comment',
  review: 'Review',
  goal: 'Goal',
  implementation: 'Implement',
};

function workflowLabel(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === 'followup' || lower === 'follow-up') return 'Follow-up';
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function taskTypeLabel(taskType: string | null | undefined): string | null {
  if (!taskType) return null;
  const known = TASK_TYPE_LABELS[taskType.toLowerCase()];
  if (known) return known;
  const words = taskType.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

export function splitWorkTitle(title: string | null | undefined, taskType?: string | null): WorkTitle {
  let rest = (title ?? '').trim();
  let type: string | null = null;

  const workflow = PR_WORKFLOW_PREFIX.exec(rest);
  if (workflow) {
    type = workflowLabel(workflow[1]);
    rest = rest.slice(workflow[0].length);
  } else {
    for (const [pattern, label] of TITLE_PREFIXES) {
      const match = pattern.exec(rest);
      if (!match) continue;
      type = label;
      rest = rest.slice(match[0].length);
      break;
    }
  }

  rest = rest.replace(MODEL_TAGS, '').trim();
  return { type: type ?? taskTypeLabel(taskType), title: rest || null };
}
