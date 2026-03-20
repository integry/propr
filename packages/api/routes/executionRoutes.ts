import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import path from 'path';
import { validateSessionId, validateTaskId, validateLogType } from './validation.js';

interface ExecutionRoutesDeps {
  redisClient: RedisClientType;
  db: Knex;
}

export function createExecutionRoutes(deps: ExecutionRoutesDeps) {
  const { redisClient, db } = deps;

  async function getPrompt(req: Request, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;

      // Validate sessionId parameter
      const sessionIdValidation = validateSessionId(sessionId);
      if (!sessionIdValidation.valid) {
        res.status(400).json({ error: sessionIdValidation.error });
        return;
      }

      // Validate conversationId if provided
      if (req.query.conversationId) {
        const convIdValidation = validateSessionId(req.query.conversationId);
        if (!convIdValidation.valid) {
          res.status(400).json({ error: 'Invalid conversation ID format' });
          return;
        }
      }

      const promptData = await getPromptData(redisClient, sessionId, req.query.conversationId as string | undefined);
      if (!promptData) {
        res.status(404).json({ error: 'Prompt not found for this execution' });
        return;
      }
      res.json({ sessionId, ...promptData });
    } catch (error) {
      console.error('Error in /api/execution/:sessionId/prompt:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function getLogs(req: Request, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;

      // Validate sessionId parameter
      const sessionIdValidation = validateSessionId(sessionId);
      if (!sessionIdValidation.valid) {
        res.status(400).json({ error: sessionIdValidation.error });
        return;
      }

      // Validate conversationId if provided
      if (req.query.conversationId) {
        const convIdValidation = validateSessionId(req.query.conversationId);
        if (!convIdValidation.valid) {
          res.status(400).json({ error: 'Invalid conversation ID format' });
          return;
        }
      }

      const logData = await getLogData(redisClient, sessionId, req.query.conversationId as string | undefined);
      if (!logData || !logData.files) {
        res.status(404).json({ error: 'Log files not found for this execution' });
        return;
      }
      res.json({ sessionId, ...logData });
    } catch (error) {
      console.error('Error in /api/execution/:sessionId/logs:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function getLogByType(req: Request, res: Response): Promise<void> {
    try {
      const { sessionId, type } = req.params;

      // Validate sessionId parameter
      const sessionIdValidation = validateSessionId(sessionId);
      if (!sessionIdValidation.valid) {
        res.status(400).json({ error: sessionIdValidation.error });
        return;
      }

      // Validate log type parameter
      const typeValidation = validateLogType(type);
      if (!typeValidation.valid) {
        res.status(400).json({ error: typeValidation.error });
        return;
      }

      // Validate conversationId if provided
      if (req.query.conversationId) {
        const convIdValidation = validateSessionId(req.query.conversationId);
        if (!convIdValidation.valid) {
          res.status(400).json({ error: 'Invalid conversation ID format' });
          return;
        }
      }

      const logData = await getLogData(redisClient, sessionId, req.query.conversationId as string | undefined);
      if (!logData?.files?.[type]) {
        res.status(404).json({ error: `Log file '${type}' not found` });
        return;
      }
      
      const fsPromises = await import('fs/promises');
      const filePath = logData.files[type];
      try {
        await fsPromises.access(filePath);
      } catch {
        res.status(404).json({ error: `Log file no longer exists at ${filePath}` });
        return;
      }
      
      const content = await fsPromises.readFile(filePath, 'utf8');
      res.setHeader('Content-Type', type === 'conversation' ? 'application/json' : 'text/plain');
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
      res.send(content);
    } catch (error) {
      console.error('Error in /api/execution/:sessionId/logs/:type:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function getAnalysis(req: Request, res: Response): Promise<void> {
    try {
      // Validate taskId parameter
      const taskIdValidation = validateTaskId(req.params.taskId);
      if (!taskIdValidation.valid) {
        res.status(400).json({ error: taskIdValidation.error });
        return;
      }

      const latestExecution = await db('llm_executions').where({ task_id: req.params.taskId }).orderBy('start_time', 'desc').first('execution_id', 'analysis_report');
      if (!latestExecution) {
        res.status(404).json({ error: 'No execution data found for this task.' });
        return;
      }
      if (!latestExecution.analysis_report) {
        res.status(202).json({ message: 'Analysis is pending or has not been run for this execution.', analysis: null });
        return;
      }
      res.json({ analysis: latestExecution.analysis_report });
    } catch (error) {
      console.error('Error in /api/task/:taskId/analysis:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getPrompt, getLogs, getLogByType, getAnalysis };
}

async function getPromptData(redisClient: RedisClientType, sessionId: string, conversationId?: string): Promise<Record<string, unknown> | null> {
  const sessionKey = `execution:prompt:session:${sessionId}`;
  const promptJson = await redisClient.get(sessionKey);
  if (promptJson) return JSON.parse(promptJson);
  if (conversationId) {
    const conversationKey = `execution:prompt:conversation:${conversationId}`;
    const conversationPromptJson = await redisClient.get(conversationKey);
    if (conversationPromptJson) return JSON.parse(conversationPromptJson);
  }
  return null;
}

async function getLogData(redisClient: RedisClientType, sessionId: string, conversationId?: string): Promise<{ files?: Record<string, string> } | null> {
  const sessionKey = `execution:logs:session:${sessionId}`;
  const logJson = await redisClient.get(sessionKey);
  if (logJson) return JSON.parse(logJson);
  if (conversationId) {
    const conversationKey = `execution:logs:conversation:${conversationId}`;
    const conversationLogJson = await redisClient.get(conversationKey);
    if (conversationLogJson) return JSON.parse(conversationLogJson);
  }
  return null;
}
