import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import type { Queue } from 'bullmq';
import type { RedisClientType } from 'redis';
import { isDemoViewer } from '../demoMode.js';
import { buildAgentRunAdmissionReport, type AgentRunAdmissionReportDeps } from '../services/agentRunAdmissionReport.js';

interface AgentRunAdmissionRoutesDeps {
  db: Knex;
  taskQueue: Queue;
  redisClient: RedisClientType;
  readSnapshot?: AgentRunAdmissionReportDeps['readSnapshot'];
}

/**
 * `GET /api/agent-run-admission`: what physical agent-run admission enforces,
 * globally and per agent, with the other limits a scheduler must respect.
 * Read-only. Named "admission", not "capacity": the automation `/capacity`
 * routes report subscription usage, a different thing.
 *
 * Instance members may read every task in REST, so task IDs of tasks that
 * exist are included; the read-only demo viewer sees counts only.
 */
export function createAgentRunAdmissionRoutes(deps: AgentRunAdmissionRoutesDeps) {
  async function getAgentRunAdmission(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const demo = isDemoViewer(req.authorization);
      const report = await buildAgentRunAdmissionReport(deps, {
        visibleTasks: async taskIds => demo ? new Set() : new Set((await deps.db('tasks').whereIn('task_id', taskIds).select('task_id'))
          .map((row: { task_id: string }) => row.task_id)),
        visibleRepositories: async repositories => new Set(demo ? [] : repositories),
      });
      res.json(report);
    } catch (error) {
      console.error('Error in /api/agent-run-admission:', (error as Error).message);
      res.status(500).json({ code: 'AGENT_RUN_ADMISSION_UNAVAILABLE', message: 'Agent-run admission state could not be read.' });
    }
  }
  return { getAgentRunAdmission };
}
