import type { Args, McpTool } from './tools.js';

/** `1 task`, `2 tasks`; the plural is given when English does not just add an s. */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The array a page-shaped read lists, with the entity it counts. Results carry
 * other arrays too (the repositories in scope, the grouping keys), so the
 * counted array is named per tool instead of taken as the first one found.
 */
const PAGE_ENTITIES: Record<string, [key: string, singular: string, plural?: string]> = {
  list_models: ['agents', 'agent'],
  list_docs: ['pages', 'documentation page'],
  search_docs: ['results', 'documentation match', 'documentation matches'],
  search_repository_files: ['matches', 'file match', 'file matches'],
  list_todos: ['items', 'TODO'],
  list_todo_categories: ['items', 'TODO category', 'TODO categories'],
  list_instance_members: ['members', 'instance member'],
  list_followup_handoffs: ['handoffs', 'follow-up handoff'],
  list_task_submissions: ['submissions', 'task submission'],
  list_visual_previews: ['previews', 'visual preview'],
  list_goal_attention: ['goals', 'goal needing attention', 'goals needing attention'],
  list_goal_inputs: ['inputs', 'goal input'],
  list_plan_revisions: ['revisions', 'plan revision'],
  list_plan_blocked_events: ['events', 'blocked event'],
  list_automation_definitions: ['definitions', 'automation definition'],
  list_automation_templates: ['templates', 'automation template'],
  list_automation_runs: ['runs', 'automation run'],
  list_pull_requests: ['pullRequests', 'pull request'],
  get_task_events: ['events', 'task event'],
  get_task_logs: ['events', 'log event'],
  get_task_changes: ['files', 'changed file'],
  get_pull_request_discussion: ['comments', 'comment'],
  get_repository_chat: ['messages', 'chat message'],
  get_cost_breakdown: ['rows', 'cost row'],
};

const camelCase = (words: string[]) => words.map((word, index) => index ? word[0].toUpperCase() + word.slice(1) : word).join('');
const singularOf = (word: string) => word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('s') ? word.slice(0, -1) : word;

/** A `list_<entities>` tool lists the array named after its entities (`list_tasks` → `tasks`, `list_task_submissions` → `submissions`). */
function derivedPageEntity(tool: McpTool, result: Args): [key: string, singular: string, plural: string] | undefined {
  const words = tool.name.split('_').slice(1);
  for (let start = 0; start < words.length; start += 1) {
    const key = camelCase(words.slice(start));
    if (Array.isArray(result[key])) {
      const plural = words.join(' ');
      return [key, [...words.slice(0, -1), singularOf(words[words.length - 1])].join(' '), plural];
    }
  }
  return undefined;
}

/** `N <entities>` for a page-shaped read, or undefined when the tool reads one object. */
export function pageSummary(tool: McpTool, result: Args): string | undefined {
  const known = PAGE_ENTITIES[tool.name];
  const entity = known && Array.isArray(result[known[0]]) ? known
    : /^(list|search)_/.test(tool.name) ? derivedPageEntity(tool, result) : undefined;
  if (!entity) return undefined;
  const [key, singular, plural] = entity;
  const more = result.nextOffset != null || result.nextPage != null || result.nextCursor != null || result.hasMore === true ? ' More follow.' : '';
  return `${countOf(result[key].length, singular, plural)} in this page.${more}`;
}

const words = (code: unknown) => String(code).replaceAll('_', ' ');

/** The verdict with the reasons behind it, e.g. "PR #12 is waiting: checks pending." */
function readinessSummary(result: Args): string {
  const pr = `PR #${result.number}`;
  const verdict = result.verdict;
  if (verdict === 'ready') return `${pr} is ready to integrate.`;
  if (verdict === 'merged' || verdict === 'closed') return `${pr} is ${verdict}.`;
  const reasons: unknown[] = verdict === 'blocked' ? result.blockingReasons ?? [] : result.waitingReasons ?? [];
  const because = reasons.length ? `: ${reasons.map(words).join(', ')}` : '';
  return verdict === 'unknown' ? `${pr} readiness is unknown${because}.` : `${pr} is ${verdict}${because}.`;
}

function pullRequestSummary(result: Args): string {
  const state = result.merged ? 'merged' : result.draft && result.state === 'open' ? 'open draft' : result.state;
  return `PR #${result.number} "${result.title}": ${state}.`;
}

function repositoryConfigurationSummary(args: Args, result: Args): string {
  const config = result.configuration ?? result.repositoryConfiguration ?? result;
  const repository = config.name ?? config.repository ?? args.repository;
  const enabled = config.enabled === undefined ? '' : config.enabled ? ', enabled' : ', disabled';
  const branch = config.baseBranch ? ` on ${config.baseBranch}` : '';
  return `Repository configuration for ${repository}${branch}${enabled}.`;
}

function costBreakdownSummary(result: Args): string {
  const rows = Array.isArray(result.rows) ? result.rows.length : 0;
  const grouping = Array.isArray(result.group_by) && result.group_by.length ? ` grouped by ${result.group_by.join(', ')}` : '';
  return `Cost breakdown${grouping}: ${countOf(rows, 'row')} for ${result.period ?? 'all time'}.`;
}

const OBJECT_SUMMARIES: Record<string, (args: Args, result: Args) => string> = {
  get_pull_request: (_args, result) => pullRequestSummary(result),
  get_pull_request_readiness: (_args, result) => readinessSummary(result),
  get_repository_configuration: repositoryConfigurationSummary,
  get_cost_breakdown: (_args, result) => costBreakdownSummary(result),
};

/** A read without a dedicated summary: the counted entity for a page, otherwise what was read. */
export function genericReadSummary(tool: McpTool, args: Args, result: Args): string {
  const object = OBJECT_SUMMARIES[tool.name];
  if (object) return object(args, result);
  const page = pageSummary(tool, result);
  const label = tool.name.replaceAll('_', ' ');
  return page ? `${label}: ${page}` : `${label}: retrieved.`;
}
