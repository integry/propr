import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import path from 'path';
import * as configRepoManager from '@gitfix/core';
import { getExecutionAnalysis } from '@gitfix/core';

interface ExecutionRoutesDeps {
  redisClient: RedisClientType;
  db: Knex | null;
  isDbEnabled: boolean;
}

export function createExecutionRoutes(deps: ExecutionRoutesDeps) {
  const { redisClient, db, isDbEnabled } = deps;

  async function getPrompt(req: Request, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;
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
    if (!isDbEnabled || !db) {
      res.status(503).json({ error: 'Database persistence is not enabled.' });
      return;
    }
    try {
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

  async function runDeepDiveAnalysis(req: Request, res: Response): Promise<void> {
    if (!isDbEnabled || !db) {
      res.status(503).json({ error: 'Database persistence is not enabled.' });
      return;
    }
    try {
      const { taskId } = req.params;
      const latestExecution = await db('llm_executions').where({ task_id: taskId }).orderBy('start_time', 'desc').first('execution_id', 'session_id', 'analysis_report');
      if (!latestExecution) {
        res.status(404).json({ error: 'No execution data found.' });
        return;
      }
      if (latestExecution.analysis_report && (latestExecution.analysis_report as Record<string, unknown>).modelUsed !== 'claude-haiku-4-5') {
        res.status(400).json({ error: 'Deep-dive analysis has already been run for this task.' });
        return;
      }
      const task = await db('tasks').where({ task_id: taskId }).first('correlation_id');
      const settings = await configRepoManager.loadSettings();
      const advancedModel = (settings.analysis_model_advanced as string) || process.env.ANALYSIS_MODEL_ADVANCED || 'claude-opus-4-20250514';
      const analysisReport = await getExecutionAnalysis({ executionId: latestExecution.execution_id, sessionId: latestExecution.session_id, correlationId: task?.correlation_id || `deep-dive-${Date.now()}`, model: advancedModel });
      await db('llm_executions').where({ execution_id: latestExecution.execution_id }).update({ analysis_report: analysisReport });
      res.json({ analysis: analysisReport });
    } catch (error) {
      console.error('Error in /api/task/:taskId/deep-dive-analysis:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getPrompt, getLogs, getLogByType, getAnalysis, runDeepDiveAnalysis };
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
