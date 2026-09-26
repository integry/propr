import type { createTaskRoutes } from './routes/index.js';
import type { RequestHandler } from 'express';

interface TaskDeleteRouteDeps {
  taskRoutes: Pick<ReturnType<typeof createTaskRoutes>, 'deleteTask'>;
}

type RouteEntry = ['delete', string, ...RequestHandler<never>[]];

export function createTaskDeleteRouteEntries({ taskRoutes }: TaskDeleteRouteDeps): RouteEntry[] {
  return [
    ['delete', '/api/tasks/:taskId', taskRoutes.deleteTask],
    ['delete', '/api/task/:taskId', taskRoutes.deleteTask],
  ];
}
