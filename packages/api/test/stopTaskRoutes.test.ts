import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import express, { type Request, type RequestHandler } from 'express';
import type { RedisClientType } from 'redis';
import { closeConnection } from '@propr/core';
import { createDockerRoutes } from '../routes/dockerRoutes.js';
import type { StopTaskExecutionOptions, StopTaskExecutionResult } from '../routes/dockerRoutes.js';

after(async () => closeConnection());

type StopExecutor = (taskId: string, options: StopTaskExecutionOptions) => Promise<StopTaskExecutionResult>;

interface StopCall {
  taskId: string;
  requestedBy?: string;
}

const requireTestAuth: RequestHandler = (req, res, next) => {
  if (req.header('authorization') !== 'Bearer valid-token') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (req as Request & { user: { username: string } }).user = { username: 'cli-user' };
  next();
};

function createStopRouteApp(executeStop: StopExecutor) {
  const app = express();
  app.use('/api', requireTestAuth);
  const dockerRoutes = createDockerRoutes({
    redisClient: {} as RedisClientType,
    stopTaskExecution: executeStop,
  });
  app.post('/api/task/:taskId/stop', dockerRoutes.stopTask);
  app.post('/api/task/:taskId/cancel', dockerRoutes.stopTask);
  return app;
}

async function withServer(app: express.Express, callback: (origin: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

async function post(origin: string, path: string, authenticated = true): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: authenticated ? { authorization: 'Bearer valid-token' } : {},
  });
}

describe('task stop routes', () => {
  test('canonical stop and cancel alias share the stop handler for encoded task IDs', async () => {
    const calls: StopCall[] = [];
    const executeStop: StopExecutor = async (taskId, options) => {
      calls.push({ taskId, requestedBy: options.requestedBy });
      return {
        success: true,
        taskId,
        containerStopped: false,
        removedQueuedJobs: 1,
        cancellationRecorded: true,
        message: 'Removed 1 queued job(s) before execution started.',
      };
    };
    const app = createStopRouteApp(executeStop);

    await withServer(app, async origin => {
      for (const suffix of ['stop', 'cancel']) {
        const response = await post(origin, `/api/task/task%2Ealpha_beta-42%2E1/${suffix}`);
        assert.equal(response.status, 200, suffix);
        assert.deepEqual(await response.json(), {
          success: true,
          message: 'Removed 1 queued job(s) before execution started.',
          taskId: 'task.alpha_beta-42.1',
          containerStopped: false,
        });
      }
    });

    assert.deepEqual(calls, [
      { taskId: 'task.alpha_beta-42.1', requestedBy: 'cli-user' },
      { taskId: 'task.alpha_beta-42.1', requestedBy: 'cli-user' },
    ]);
  });

  test('both stop paths require authentication before task-id validation or execution', async () => {
    const calls: StopCall[] = [];
    const app = createStopRouteApp(async (taskId) => {
      calls.push({ taskId });
      throw new Error('executor should not run');
    });

    await withServer(app, async origin => {
      for (const suffix of ['stop', 'cancel']) {
        const response = await post(origin, `/api/task/bad%20task/${suffix}`, false);
        assert.equal(response.status, 401, suffix);
        assert.deepEqual(await response.json(), { error: 'Unauthorized' });
      }
    });

    assert.equal(calls.length, 0);
  });

  test('both stop paths return the same validation and task-state status bodies', async () => {
    const executeStop: StopExecutor = async (taskId) => {
      if (taskId === 'missing') {
        return {
          success: false,
          taskId,
          containerStopped: false,
          removedQueuedJobs: 0,
          notFound: true,
          message: 'The task may have already completed or does not exist.',
        };
      }
      return {
        success: false,
        taskId,
        containerStopped: false,
        removedQueuedJobs: 0,
        notRunning: true,
        currentState: 'completed',
        message: 'The task has already completed or is not in an active state.',
      };
    };
    const app = createStopRouteApp(executeStop);

    await withServer(app, async origin => {
      for (const suffix of ['stop', 'cancel']) {
        const invalid = await post(origin, `/api/task/bad%20task/${suffix}`);
        assert.equal(invalid.status, 400, suffix);
        assert.deepEqual(await invalid.json(), { error: 'Task ID contains invalid characters' });

        const missing = await post(origin, `/api/task/missing/${suffix}`);
        assert.equal(missing.status, 404, suffix);
        assert.deepEqual(await missing.json(), {
          error: 'Task not found',
          message: 'The task may have already completed or does not exist.',
        });

        const done = await post(origin, `/api/task/done/${suffix}`);
        assert.equal(done.status, 400, suffix);
        assert.deepEqual(await done.json(), {
          error: 'Task is not running',
          message: 'The task has already completed or is not in an active state.',
          currentState: 'completed',
        });
      }
    });
  });

  test('both stop paths return sanitized error bodies', async () => {
    const app = createStopRouteApp(async () => {
      throw new Error('redis password leaked in internal failure');
    });

    await withServer(app, async origin => {
      for (const suffix of ['stop', 'cancel']) {
        const response = await post(origin, `/api/task/task-a/${suffix}`);
        assert.equal(response.status, 500, suffix);
        assert.deepEqual(await response.json(), { error: 'Internal server error' });
      }
    });
  });
});
