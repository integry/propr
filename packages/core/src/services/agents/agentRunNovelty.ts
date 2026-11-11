import { createHash } from 'node:crypto';
import { AUTOMATION_REPORT_MIN_NOVEL_CHARS, type AutomationReportNovelty } from '@propr/shared';

/**
 * Report novelty: whether a run's report says anything the previous reported
 * run of the same definition did not. Reports are compared by a hash of their
 * normalised text, so a nightly report that differs only in its date, the run
 * id it quotes or its line wrapping still counts as unchanged.
 */

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
/** Normalisations applied in order: ids first, then full timestamps before their date and time parts. */
const VOLATILE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [UUID, '<id>'],
  // ISO 8601 dates and timestamps, e.g. 2026-11-11, 2026-11-11T22:00:00.123Z, 2026-11-11 22:00 UTC.
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s?(?:Z|UTC|GMT|[+-]\d{2}:?\d{2})\b)?)?/gi, '<date>'],
  // Numeric dates: 11/11/2026, 11/11/26, 2026/11/11, 11.11.2026. Dotted forms need a
  // four-digit year so version numbers (4.17.21) are kept.
  [/(?<![\w.])(?:\d{4}\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}\.\d{1,2}\.\d{1,2}|\d{1,2}\.\d{1,2}\.\d{4})(?![\w]|\.\d)/g, '<date>'],
  // Named months: Nov 11, 2026 / 11th November 2026 / November 2026.
  [new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'gi'), '<date>'],
  [new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+\\d{4})?\\b`, 'gi'), '<date>'],
  [new RegExp(`\\b${MONTH}\\s+\\d{4}\\b`, 'gi'), '<date>'],
  [/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '<day>'],
  // Clock times: 22:00, 10:30:15, 9:05 pm, 22:00 UTC.
  [/\b\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s?(?:[ap]m\b|[ap]\.m\.))?(?:\s?(?:UTC|GMT|Z)\b)?/gi, '<time>'],
  // Epoch milliseconds, as runs and tasks print them.
  [/\b1\d{12}\b/g, '<time>'],
  // Relative times: "3 hours ago".
  [/\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi, '<ago>'],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The report text with whitespace, dates, times and run ids normalised.
 * `runIds` are replaced verbatim first, so ids that are not UUIDs are covered too.
 */
export function normalizeAgentReport(report: string, { runIds = [] }: { runIds?: readonly string[] } = {}): string {
  let text = report.normalize('NFKC');
  for (const runId of runIds) {
    if (runId) text = text.replace(new RegExp(escapeRegExp(runId), 'g'), '<run>');
  }
  for (const [pattern, replacement] of VOLATILE_PATTERNS) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, ' ').trim();
}

/** SHA-256 (hex) of the normalised report. */
export function hashAgentReport(report: string, options: { runIds?: readonly string[] } = {}): string {
  return createHash('sha256').update(normalizeAgentReport(report, options), 'utf8').digest('hex');
}

export interface AgentReportNoveltyInput {
  runId: string;
  /** The report as stored (already truncated to the stored maximum). */
  report: string;
  /** The previous reported run of the definition, or null when there is none. */
  previous: { runId: string; report: string } | null;
  minCharacters?: number;
}

export interface AgentReportNovelty {
  reportHash: string;
  reportNovelty: AutomationReportNovelty;
}

/**
 * Classifies a report against the previous one. The previous report is
 * re-hashed rather than trusting its stored hash, so runs recorded before the
 * flag existed (or under an older normalisation) still compare correctly.
 */
export function classifyAgentReportNovelty({ runId, report, previous, minCharacters = AUTOMATION_REPORT_MIN_NOVEL_CHARS }: AgentReportNoveltyInput): AgentReportNovelty {
  const runIds = previous ? [runId, previous.runId] : [runId];
  const normalized = normalizeAgentReport(report, { runIds });
  const reportHash = createHash('sha256').update(normalized, 'utf8').digest('hex');
  if (normalized.length < minCharacters) return { reportHash, reportNovelty: 'empty' };
  if (previous && hashAgentReport(previous.report, { runIds }) === reportHash) return { reportHash, reportNovelty: 'unchanged' };
  return { reportHash, reportNovelty: 'new' };
}
