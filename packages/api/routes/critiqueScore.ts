/**
 * Implementation critique scores recorded on LLM executions.
 *
 * The score lives inside a JSON report stored on `llm_executions.analysis_report`,
 * so reading it means parsing the outer envelope and then the report body. The
 * parsing rules live here rather than being reimplemented per consumer.
 */

import type { Knex } from 'knex';

export function parseAnalysisReport(value: unknown): { valid: boolean; report?: unknown } {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const report = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).report
      : undefined;
    return { valid: true, report };
  } catch {
    return { valid: false };
  }
}

export function extractCritiqueScore(report: unknown): unknown {
  const reportText = typeof report === 'string' ? report : JSON.stringify(report);
  const jsonStart = reportText.indexOf('{');
  if (jsonStart < 0) return null;

  // Match SQLite RTRIM(..., CHAR(10) || CHAR(13) || ' ' || '`').
  const cleanJson = reportText.slice(jsonStart).replace(/[\n\r `]+$/g, '');
  try {
    const parsed = JSON.parse(cleanJson);
    if (parsed === null || typeof parsed !== 'object') return null;
    const score = (parsed as Record<string, unknown>).implementation_critique_score ?? null;
    // SQLite json_extract represents JSON booleans as integer 1/0.
    return typeof score === 'boolean' ? Number(score) : score;
  } catch {
    return null;
  }
}

/**
 * Latest critique score per task.
 *
 * Executions are read newest first so the newest valid outer JSON decides the
 * score. A valid execution without a `$.report` body means "no score", never a
 * fallback to an older execution.
 */
export async function loadCritiqueScores(db: Knex, taskIds: string[]): Promise<Map<string, unknown>> {
  const scores = new Map<string, unknown>();
  if (taskIds.length === 0) return scores;

  const executionRows = await db('llm_executions')
    .whereIn('task_id', taskIds)
    .whereNotNull('analysis_report')
    .select('task_id', 'analysis_report')
    .orderBy('task_id', 'asc')
    .orderBy('execution_id', 'desc') as Array<Record<string, unknown>>;

  const tasksWithValidReport = new Set<string>();
  for (const row of executionRows) {
    const taskId = String(row.task_id);
    if (tasksWithValidReport.has(taskId)) continue;
    const analysisReport = parseAnalysisReport(row.analysis_report);
    if (!analysisReport.valid) continue;
    tasksWithValidReport.add(taskId);
    if (analysisReport.report !== null && analysisReport.report !== undefined) {
      scores.set(taskId, extractCritiqueScore(analysisReport.report));
    }
  }
  return scores;
}
