import type { Knex } from 'knex';

export async function fetchUsageMetrics(
  db: Knex,
  taskId: string
): Promise<{ usageMetrics: Record<string, unknown> | null; usageMetricRecords: Array<{ agent: string; metricKey: string; metricValue: number }> }> {
  const llmLog = await db('llm_logs')
    .where({ draft_id: taskId, execution_type: 'implementation' }).orderBy('start_time', 'desc').first();
  if (!llmLog) return { usageMetrics: null, usageMetricRecords: [] };

  let usageMetrics: Record<string, unknown> | null = null;
  if (llmLog.usage_metrics) {
    try {
      usageMetrics = typeof llmLog.usage_metrics === 'string' ? JSON.parse(llmLog.usage_metrics) : llmLog.usage_metrics;
    } catch (e) { console.error('Failed to parse usage_metrics:', e); }
  }
  const records = await db('usage_metric_records').where({ llm_log_id: llmLog.log_id });
  const usageMetricRecords = records.map((r: Record<string, unknown>) => ({
    agent: r.agent_name as string, metricKey: r.metric_key as string, metricValue: r.metric_value as number
  }));
  return { usageMetrics, usageMetricRecords };
}
