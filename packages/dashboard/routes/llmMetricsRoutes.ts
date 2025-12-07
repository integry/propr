import { Request, Response } from 'express';
import { getLLMMetricsSummary, getLLMMetricsByCorrelationId } from '../llmMetricsAdapter.js';

export function createLLMMetricsRoutes() {
  async function getSummary(_req: Request, res: Response): Promise<void> {
    try {
      res.json(await getLLMMetricsSummary());
    } catch (error) {
      console.error('Error in /api/llm-metrics:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function getByCorrelationId(req: Request, res: Response): Promise<void> {
    try {
      const metrics = await getLLMMetricsByCorrelationId(req.params.correlationId);
      if (!metrics) {
        res.status(404).json({ error: 'Metrics not found for this correlation ID' });
        return;
      }
      res.json(metrics);
    } catch (error) {
      console.error('Error in /api/llm-metrics/:correlationId:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getSummary, getByCorrelationId };
}
