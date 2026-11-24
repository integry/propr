import { z } from 'zod';
import { McpError } from './config.js';
import type { McpPrincipal } from './policy.js';
import { type McpTool, type ToolDeps, ok } from './tools.js';
import { buildAgentRunAdmissionReport } from '../services/agentRunAdmissionReport.js';

export const AGENT_RUN_ADMISSION_TOOL = 'get_agent_run_admission';

/** Repositories of this grant the principal may read, by lowercased handle (one policy check per repository). */
function grantedRepositories(deps: ToolDeps, principal: McpPrincipal) {
  const granted = new Set(principal.grant.repositories.map(name => name.toLowerCase()));
  const checked = new Map<string, Promise<boolean>>();
  return (repository: string): Promise<boolean> => {
    const key = repository.toLowerCase();
    if (!granted.has(key)) return Promise.resolve(false);
    let result = checked.get(key);
    if (!result) {
      result = deps.policy.repository(principal, repository).then(() => true, (error: unknown) => {
        if (error instanceof McpError && (error.status === 403 || error.status === 404)) return false;
        throw error;
      });
      checked.set(key, result);
    }
    return result;
  };
}

export function addAdmissionTools(tools: McpTool[], deps: ToolDeps): void {
  tools.push({
    name: AGENT_RUN_ADMISSION_TOOL,
    description: 'Read what agent-run admission enforces right now: whether it is enabled, the global limit and its source, and globally and per direct agent the ceiling and the running, reserved, recovering, waiting (global limit, agent ceiling) and deferred executions, nested executions apart. Also queue worker concurrency and repository workflow slots, each labelled. Not subscription usage (get_provider_usage). Task IDs and repositories only within this grant.',
    scope: 'read',
    readOnly: true,
    schema: z.object({}).strict(),
    run: async ({ principal }) => {
      const repositoryVisible = grantedRepositories(deps, principal);
      const report = await buildAgentRunAdmissionReport({ ...deps, readSnapshot: deps.agentRunAdmissionSnapshot }, {
        visibleTasks: async taskIds => {
          const rows = await deps.db('tasks').whereIn('task_id', taskIds).select('task_id', 'repository') as Array<{ task_id: string; repository: string | null }>;
          const visible = await Promise.all(rows.map(async row => row.repository && await repositoryVisible(row.repository) ? row.task_id : null));
          return new Set(visible.filter((id): id is string => id !== null));
        },
        visibleRepositories: async repositories => new Set((await Promise.all(repositories
          .map(async repository => await repositoryVisible(repository) ? repository : null))).filter((name): name is string => name !== null)),
      });
      return ok(report);
    },
  });
}
